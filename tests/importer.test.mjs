// Importing from other browsers: Chrome-style passwords (macOS "v10" format),
// Safari bookmarks and history, and exported bookmark files.
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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-imp-'));
const mac = process.platform === 'darwin';

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
    { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://lumio-usa.online/', URIDictionary: { title: 'Lumio' } },
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
  assert.deepEqual(readBookmarks().map((b) => [b.url, b.title]), [['https://apple.com/', 'Apple'], ['https://lumio-usa.online/', 'Lumio']]);
  const h = readHistory();
  assert.deepEqual(h.map((x) => [x.url, x.title]), [['https://example.com/page', 'Example page']]);
  assert.ok(Math.abs(h[0].time - (Date.now() - 60000)) < 30000);
  delete process.env.LUMIO_SAFARI_DIR;
});

test('exported bookmark files (Netscape HTML from Safari, Chrome, Firefox)', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p><DT><H3>Favorites</H3>
<DL><p><DT><A HREF="https://apple.com/" ADD_DATE="1700000000">Apple &amp; Co</A>
<DT><A HREF="javascript:alert(1)">Not a site</A>
<DT><A HREF="https://example.com/?a=1&amp;b=2"></A></DL></DL>`;
  assert.deepEqual(parseBookmarksHtml(html), [
    { url: 'https://apple.com/', title: 'Apple & Co', time: 1700000000000 },
    { url: 'https://example.com/?a=1&b=2', title: 'https://example.com/?a=1&b=2', time: parseBookmarksHtml(html)[1].time },
  ]);
});
