// Password store: encryption boundary, matching, save/update decisions, CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PasswordStore, generatePassword, isWeak, parseCsv, siteKey } = require('../main/passwords.js');

// Stand-in for Electron's safeStorage: reversible, and never plain text.
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('hex')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString(),
};
const fresh = (safe = fakeSafe) => new PasswordStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-pw-')), safe);

test('passwords are never stored in plain text', () => {
  const s = fresh();
  s.save({ origin: 'https://site.example', username: 'me', password: 'hunter2-Secret!' });
  s.file.flush();
  const raw = fs.readFileSync(s.file.file, 'utf8');
  assert.ok(!raw.includes('hunter2'));
  assert.equal(s.secret(s.entries[0].id), 'hunter2-Secret!');
  assert.ok(!JSON.stringify(s.list()).includes('hunter2'), 'list() has no secrets');
});

test('saving is refused without encryption', () => {
  const s = fresh({ isEncryptionAvailable: () => false });
  assert.throws(() => s.save({ origin: 'https://a.example', username: 'x', password: 'y' }), /encryption/);
});

test('sites match ignoring www., but not across schemes or hosts', () => {
  assert.equal(siteKey('https://www.example.com/login'), 'https://example.com');
  assert.equal(siteKey('https://example.com:8443/x'), 'https://example.com:8443');
  assert.equal(siteKey('ftp://example.com'), null);
  const s = fresh();
  s.save({ origin: 'https://www.example.com', username: 'a', password: 'p1' });
  assert.equal(s.forOrigin('https://example.com').length, 1);
  assert.equal(s.forOrigin('http://example.com').length, 0);
  assert.equal(s.forOrigin('https://evil-example.com').length, 0);
  assert.equal(s.forOrigin('https://sub.example.com').length, 0);
});

test('save, update or nothing after a sign-in', () => {
  const s = fresh();
  assert.equal(s.classify('https://x.example', 'me', 'one').action, 'save');
  const id = s.save({ origin: 'https://x.example', username: 'me', password: 'one' });
  assert.deepEqual(s.classify('https://x.example', 'me', 'one'), { action: 'none', id });
  assert.deepEqual(s.classify('https://x.example', 'me', 'two'), { action: 'update', id });
  assert.deepEqual(s.classify('https://x.example', '', 'two'), { action: 'update', id }, 'change-password form without a username');
  assert.equal(s.classify('https://x.example', 'other', 'two').action, 'save');
});

test('never-save list', () => {
  const s = fresh();
  s.addNever('https://www.bank.example/login');
  assert.equal(s.isNever('https://bank.example'), true);
  s.removeNever('https://bank.example');
  assert.equal(s.isNever('https://bank.example'), false);
});

test('weak and reused passwords are flagged', () => {
  assert.equal(isWeak('password123'), true);
  assert.equal(isWeak('short1!'), true);
  assert.equal(isWeak('alllowercaseletters'), false);
  assert.equal(isWeak('Tr0ub4dor&3'), false);
  const s = fresh();
  s.save({ origin: 'https://a.example', username: 'u', password: 'Same-Pass-123!' });
  s.save({ origin: 'https://b.example', username: 'u', password: 'Same-Pass-123!' });
  s.save({ origin: 'https://c.example', username: 'u', password: 'qwerty' });
  const flags = Object.fromEntries(s.list().map((e) => [e.site, { weak: e.weak, reused: e.reused }]));
  assert.deepEqual(flags['a.example'], { weak: false, reused: true });
  assert.deepEqual(flags['c.example'], { weak: true, reused: false });
});

test('generated passwords are strong and varied', () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.equal(a.length, 18);
  assert.notEqual(a, b);
  assert.ok(/[a-z]/.test(a) && /[A-Z]/.test(a) && /\d/.test(a) && /[^A-Za-z0-9]/.test(a));
  assert.equal(isWeak(a), false);
});

test('CSV import (Chrome format) and export round-trip', () => {
  const rows = parseCsv('name,url,username,password,note\r\n"Site, Inc",https://a.example/login,alice,"p,""w""1",hi\nb,https://b.example,,pw2,\n');
  assert.deepEqual(rows[1], ['Site, Inc', 'https://a.example/login', 'alice', 'p,"w"1', 'hi']);
  const s = fresh();
  const res = s.importCsv('﻿name,url,username,password,note\na,https://a.example/login,alice,"p,""w""1",hi\nb,https://b.example,,pw2,\nbad,not a url,x,y,\n');
  assert.deepEqual(res, { added: 2, updated: 0, skipped: 1 });
  assert.deepEqual(s.importCsv('url,username,password\nhttps://a.example,alice,"p,""w""1"\n'), { added: 0, updated: 0, skipped: 1 });
  const out = s.exportCsv();
  assert.match(out, /^name,url,username,password,note\n/);
  assert.ok(out.includes('"p,""w""1"'));
  const again = fresh();
  assert.equal(again.importCsv(out).added, 2);
  assert.throws(() => fresh().importCsv('foo,bar\n1,2\n'), /url and password/);
});
