// Importing from other browsers: Chrome-style passwords (macOS "v10" format),
// Chrome's profiles and bookmark folders, Firefox, Safari bookmarks and
// history, and exported bookmark files, all keeping their folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readPasswords, BROWSERS } = require('../main/importer/chromium.js');
const { parseBookmarksHtml } = require('../main/importer/files.js');
const { Store } = require('../main/store.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-imp-'));
const mac = process.platform === 'darwin';
// Lists as nested titles: ['A', ['Folder', ['B']]].
const shape = (list) => list.map((n) => (n.children ? [n.title, shape(n.children)] : n.title));

test('Chrome passwords: decrypted with the browser key (v10, AES-128-CBC)', async () => {
  const profile = tmp();
  const secret = 'chrome-keychain-secret';
  const key = crypto.pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
  const enc = (pw) => { const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20)); return Buffer.concat([Buffer.from('v10'), c.update(pw, 'utf8'), c.final()]); };
  const db = new DatabaseSync(path.join(profile, 'Login Data'));
  db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)');
  const ins = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?)');
  ins.run('https://github.com/login', 'sam', enc('hunter2-ñ'), 0);
  ins.run('https://news.example.com/', 'sam@example.com', enc('pa55word'), 0);
  ins.run('https://never.example.com/', '', Buffer.alloc(0), 1); // "never save" entries are skipped
  ins.run('https://old.example.com/', 'x', Buffer.from('v11-other-format'), 0); // other formats are skipped
  db.close();
  const list = await readPasswords(BROWSERS.find((b) => b.id === 'chrome'), profile, { secret });
  assert.deepEqual(list, [
    { url: 'https://github.com/login', username: 'sam', password: 'hunter2-ñ' },
    { url: 'https://news.example.com/', username: 'sam@example.com', password: 'pa55word' },
  ]);
  await assert.rejects(readPasswords(BROWSERS[0], profile, { secret: 'wrong' }), /couldn’t read/);
});

test('Safari bookmarks (plist) and history (SQLite)', { skip: !mac }, () => {
  const dir = tmp();
  process.env.LUMIO_SAFARI_DIR = dir;
  const { readBookmarks, readHistory, detect } = require('../main/importer/safari.js');
  const plist = { Children: [
    { Title: 'BookmarksBar', Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://apple.com/', URIDictionary: { title: 'Apple' } }] },
    { Title: 'com.apple.ReadingList', Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://later.example.com/' }] },
    { Title: 'BookmarksMenu', WebBookmarkType: 'WebBookmarkTypeList', Children: [
      { Title: 'News', WebBookmarkType: 'WebBookmarkTypeList', Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://news.example/', URIDictionary: { title: 'News site' } }] },
    ] },
    { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://lumio-usa.online/', URIDictionary: { title: 'Lumio' } },
    { Title: 'History', WebBookmarkType: 'WebBookmarkTypeProxy' },
  ] };
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(plist));
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', path.join(dir, 'Bookmarks.plist'), path.join(dir, 'b.json')]);
  const db = new DatabaseSync(path.join(dir, 'History.db'));
  db.exec('CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)');
  db.exec("INSERT INTO history_items VALUES (1, 'https://example.com/page'), (2, 'file:///etc/hosts')");
  const now = (Date.now() - 978307200000) / 1000;
  db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(1, now - 60, 'Example page');
  db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(2, now - 30, 'Hosts');
  db.close();
  assert.deepEqual(detect().map((s) => s.id), ['safari']);
  // Favorites is the bar; the Bookmarks menu and the rest go in Other bookmarks, folders kept.
  const marks = readBookmarks();
  assert.deepEqual([shape(marks.bar), shape(marks.other), shape(marks.mobile)], [['Apple'], [['News', ['News site']], 'Lumio'], []]);
  assert.deepEqual([marks.bar[0].url, marks.other[0].children[0].url], ['https://apple.com/', 'https://news.example/']);
  const h = readHistory();
  assert.deepEqual(h.map((x) => [x.url, x.title]), [['https://example.com/page', 'Example page']]);
  assert.ok(Math.abs(h[0].time - (Date.now() - 60000)) < 30000);
  delete process.env.LUMIO_SAFARI_DIR;
});

test('exported bookmark files (Netscape HTML from Safari, Chrome, Firefox) keep their folders', () => {
  // Safari's export: no toolbar mark, "Favorites" is the bar; its reading list is skipped.
  const safari = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p><DT><H3>Favorites</H3>
<DL><p><DT><A HREF="https://apple.com/" ADD_DATE="1700000000">Apple &amp; Co</A>
<DT><A HREF="javascript:alert(1)">Not a site</A>
<DT><A HREF="https://example.com/?a=1&amp;b=2"></A>
<DT><H3>Work</H3>
<DL><p><DT><A HREF="https://jira.example/">Jira</A></DL><p>
</DL><p>
<DT><H3 id="com.apple.ReadingList">Reading List</H3>
<DL><p><DT><A HREF="https://later.example/">Later</A></DL><p>
<DT><A HREF="https://loose.example/">Loose</A>
</DL>`;
  const got = parseBookmarksHtml(safari);
  assert.deepEqual(got.bar[0], { url: 'https://apple.com/', title: 'Apple & Co', time: 1700000000000 });
  assert.deepEqual([got.bar[1].url, got.bar[1].title], ['https://example.com/?a=1&b=2', 'https://example.com/?a=1&b=2']);
  assert.ok(Math.abs(got.bar[1].time - Date.now()) < 60000, 'no date: now');
  assert.deepEqual(shape(got.bar), ['Apple & Co', 'https://example.com/?a=1&b=2', ['Work', ['Jira']]], 'javascript: links are skipped');
  assert.deepEqual(shape(got.other), ['Loose']);
  // Firefox's: the toolbar is marked; the menu's folders and Other Bookmarks go in Other bookmarks.
  const firefox = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 ADD_DATE="1" LAST_MODIFIED="2">Mozilla Firefox</H3>
    <DL><p><DT><A HREF="https://support.mozilla.org/">Get Help</A></DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p><DT><A HREF="https://bar.example/">On the bar</A></DL><p>
    <DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3>
    <DL><p><DT><A HREF="https://unfiled.example/">Unfiled</A></DL><p>
    <DT><H3>Mobile Bookmarks</H3>
    <DL><p><DT><A HREF="https://phone.example/">Phone</A></DL><p>
</DL>`;
  const ff = parseBookmarksHtml(firefox);
  assert.deepEqual(shape(ff.bar), ['On the bar']);
  assert.deepEqual(shape(ff.other), [['Mozilla Firefox', ['Get Help']], 'Unfiled']);
  assert.deepEqual(shape(ff.mobile), ['Phone']);
  // A file with just links (no folders at all) lands in Other bookmarks.
  assert.deepEqual(shape(parseBookmarksHtml('<A HREF="https://x.example/">X</A>').other), ['X']);
});

// A fake Application Support folder with Chrome profiles.
function chromeRoot() {
  const root = tmp();
  const base = path.join(root, ...BROWSERS.find((b) => b.id === 'chrome').dir.split('/'));
  const chromeTime = (ms) => String((ms + 11644473600000) * 1000);
  const profile = (dir, bar) => {
    fs.mkdirSync(path.join(base, dir), { recursive: true });
    fs.writeFileSync(path.join(base, dir, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: bar }, other: { type: 'folder', children: [{ type: 'url', name: 'Other one', url: 'https://other.example/' }] }, synced: { type: 'folder', children: [] } } }));
  };
  profile('Default', [{ type: 'url', name: 'Personal', url: 'https://personal.example/', date_added: chromeTime(1700000000000) }]);
  profile('Profile 2', [
    { type: 'url', name: 'Work mail', url: 'https://mail.work.example/' },
    { type: 'folder', name: 'Projects', date_added: chromeTime(1700000000000), children: [{ type: 'url', name: 'Tracker', url: 'https://tracker.example/' }, { type: 'folder', name: 'Old', children: [] }] },
  ]);
  fs.mkdirSync(path.join(base, 'Profile 3'), { recursive: true }); // made by Chrome, never used: nothing to import
  fs.writeFileSync(path.join(base, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2', info_cache: { Default: { name: 'Juan' }, 'Profile 2': { name: 'Work' }, 'Profile 3': { name: 'Empty' } } } }));
  return root;
}

test('Chrome: every profile is listed by its name, and bookmarks come with their folders', async () => {
  process.env.LUMIO_IMPORT_ROOT = chromeRoot();
  try {
    const chromium = require('../main/importer/chromium.js');
    assert.deepEqual(chromium.detect().map(({ id, name }) => [id, name]), [['chrome:Profile 2', 'Google Chrome (Work)'], ['chrome:Default', 'Google Chrome (Juan)']], 'the one used last first');
    const [work] = chromium.profiles(BROWSERS.find((b) => b.id === 'chrome'));
    const marks = chromium.readBookmarks(work.path);
    assert.deepEqual(shape(marks.bar), ['Work mail', ['Projects', ['Tracker', ['Old', []]]]]);
    assert.equal(marks.bar[1].time, 1700000000000);
    assert.deepEqual(shape(marks.other), ['Other one']);
    // Import the work profile into a store whose bar already has something.
    const store = new Store(tmp(), null);
    store.marks.add('bar', null, { url: 'https://mine.example/', title: 'Mine' });
    const res = await chromium.importFrom('chrome:Profile 2', store, { history: false });
    assert.deepEqual([res.ok, res.bookmarks], [true, 3]);
    const bar = store.marks.root('bar').children;
    assert.deepEqual(shape(bar), ['Mine', ['Imported from Google Chrome', ['Work mail', ['Projects', ['Tracker']]]]]);
    assert.deepEqual(shape(store.marks.root('other').children), ['Other one']);
    assert.equal((await chromium.importFrom('chrome:Profile 9', store, {})).ok, false);
    // Just one profile with something in it: listed as the browser.
    fs.rmSync(path.join(process.env.LUMIO_IMPORT_ROOT, 'Google', 'Chrome', 'Profile 2'), { recursive: true });
    assert.deepEqual(chromium.detect().map(({ id, name }) => [id, name]), [['chrome', 'Google Chrome']]);
    assert.equal((await chromium.importFrom('chrome', new Store(tmp(), null), { history: false })).bookmarks, 2);
  } finally {
    delete process.env.LUMIO_IMPORT_ROOT;
  }
});

// A fake Firefox folder: profiles.ini and a profile's places.sqlite.
function firefoxDir() {
  const dir = tmp();
  const prof = (rel, n) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(p, { recursive: true });
    const db = new DatabaseSync(path.join(p, 'places.sqlite'));
    db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);
      CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);`);
    const place = db.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)');
    const mark = db.prepare('INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    place.run(1, 'https://bar.example/', 'Bar page');
    place.run(2, 'https://menu.example/', 'Menu page');
    place.run(3, 'https://deep.example/', 'Deep page');
    place.run(4, 'place:sort=8&maxResults=10', 'Most Visited');
    place.run(5, 'https://visited.example/', 'Visited');
    place.run(6, 'https://phone.example/', 'Phone');
    // Firefox's fixed folders.
    mark.run(1, 2, null, 0, 0, '', 0, 'root________');
    mark.run(2, 2, null, 1, 0, 'menu', 0, 'menu________');
    mark.run(3, 2, null, 1, 1, 'toolbar', 0, 'toolbar_____');
    mark.run(4, 2, null, 1, 2, 'tags', 0, 'tags________');
    mark.run(5, 2, null, 1, 3, 'unfiled', 0, 'unfiled_____');
    mark.run(6, 2, null, 1, 4, 'mobile', 0, 'mobile______');
    // Positions out of id order, a saved search, a separator and a tag (not bookmarks).
    mark.run(10, 1, 4, 3, 2, 'Most Visited', 1700000000000000, 'a');
    mark.run(11, 2, null, 3, 1, `Folder ${n}`, 1700000000000000, 'b');
    mark.run(12, 1, 3, 11, 0, 'Deep page', 1700000000000000, 'c');
    mark.run(13, 1, 1, 3, 0, 'Bar page', 1700000000000000, 'd');
    mark.run(14, 3, null, 2, 0, '', 0, 'e');
    mark.run(15, 1, 2, 2, 1, 'Menu page', 1700000000000000, 'f');
    mark.run(16, 2, null, 4, 0, 'a-tag', 0, 'g');
    mark.run(17, 1, 2, 16, 0, null, 0, 'h');
    mark.run(18, 1, 6, 6, 0, 'Phone', 0, 'i');
    db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (?, ?)').run(5, (Date.now() - 3600_000) * 1000);
    db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (?, ?)').run(5, (Date.now() - 200 * 86400_000) * 1000); // too old
    db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (?, ?)').run(4, Date.now() * 1000); // not a web page
    db.close();
  };
  prof('Profiles/abc.default', 'one');
  prof('Profiles/xyz.default-release', 'two');
  fs.writeFileSync(path.join(dir, 'profiles.ini'), `[Install4F96D1932A9F858E]
Default=Profiles/xyz.default-release
Locked=1

[Profile1]
Name=default
IsRelative=1
Path=Profiles/abc.default
Default=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/xyz.default-release

[Profile2]
Name=gone
IsRelative=1
Path=Profiles/gone

[General]
StartWithLastProfile=1
Version=2
`);
  return dir;
}

test('Firefox: profiles, bookmarks with folders and history, read from a copy of places.sqlite', async () => {
  process.env.LUMIO_FIREFOX_DIR = firefoxDir();
  try {
    const firefox = require('../main/importer/firefox.js');
    const importer = require('../main/importer/index.js');
    // The one Firefox opens first, first; a profile without places.sqlite isn't listed.
    assert.deepEqual(firefox.detect().map(({ id, name, passwords }) => [id, name, passwords]), [
      ['firefox:Profiles/xyz.default-release', 'Firefox (default-release)', false],
      ['firefox:Profiles/abc.default', 'Firefox (default)', false],
    ]);
    assert.ok(importer.detect().some((s) => s.id === 'firefox:Profiles/abc.default'));
    const [main] = firefox.profiles();
    const marks = firefox.readBookmarks(main.path);
    assert.deepEqual(shape(marks.bar), ['Bar page', ['Folder two', ['Deep page']]]);
    assert.deepEqual(shape(marks.other), ['Menu page']);
    assert.deepEqual(shape(marks.mobile), ['Phone']);
    assert.equal(marks.bar[0].time, 1700000000000);
    const hist = firefox.readHistory(main.path);
    assert.deepEqual(hist.map((h) => [h.url, h.title]), [['https://visited.example/', 'Visited']]);
    assert.ok(Math.abs(hist[0].time - (Date.now() - 3600_000)) < 5000);
    // Firefox keeps it open: the original isn't touched (no journal files appear next to it).
    const before = fs.readdirSync(main.path).sort();
    const store = new Store(tmp(), null);
    const res = await importer.importFrom('firefox:Profiles/abc.default', { store }, { bookmarks: true, history: true });
    assert.deepEqual([res.ok, res.browser, res.bookmarks, res.history], [true, 'Firefox', 4, 1]);
    assert.deepEqual(shape(store.marks.root('bar').children), ['Bar page', ['Folder one', ['Deep page']]]);
    assert.deepEqual(fs.readdirSync(main.path).sort(), before);
    assert.equal((await importer.importFrom('firefox:Profiles/nope', { store }, {})).ok, false);
    assert.deepEqual(firefox.parseIni('[A]\nx = 1\n; note\ny=2=3').map((s) => [s.section, s.x, s.y]), [['A', '1', '2=3']]);
  } finally {
    delete process.env.LUMIO_FIREFOX_DIR;
  }
});
