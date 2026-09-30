import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseInput, suggest, topSites } = require('../main/omnibox.js');

const G = 'https://www.google.com/search?q=%s';

test('URLs vs searches', () => {
  assert.deepEqual(parseInput('example.com', G), { url: 'https://example.com/', isSearch: false });
  assert.deepEqual(parseInput('https://a.b/c?d=1', G), { url: 'https://a.b/c?d=1', isSearch: false });
  assert.equal(parseInput('localhost:3000/x', G).url, 'http://localhost:3000/x');
  assert.equal(parseInput('192.168.1.1', G).url, 'http://192.168.1.1');
  assert.equal(parseInput('lumio://settings/', G).url, 'lumio://settings/');
  assert.equal(parseInput('what is lumio', G).url, 'https://www.google.com/search?q=what%20is%20lumio');
  assert.equal(parseInput('hello', G).isSearch, true);
  assert.equal(parseInput('3.14', G).isSearch, true);
  assert.equal(parseInput('javascript:alert(1)', G).isSearch, true);
  assert.equal(parseInput('   ', G), null);
});

test('suggestions rank history and offer Ask Lumio for searches', () => {
  const history = [
    { url: 'https://github.com/', title: 'GitHub', time: Date.now() },
    { url: 'https://news.ycombinator.com/', title: 'Hacker News', time: Date.now() },
  ];
  const s = suggest('git', { history, bookmarks: [], searchTemplate: G });
  assert.equal(s[0].type, 'search');
  assert.equal(s[1].url, 'https://github.com/');
  assert.equal(s[s.length - 1].type, 'ai');
  const u = suggest('github.com', { history, bookmarks: [], searchTemplate: G });
  assert.equal(u[0].type, 'url');
  assert.ok(!u.some((x) => x.type === 'ai'));
});

test('top sites group by origin', () => {
  const now = Date.now();
  const h = [
    { url: 'https://a.com/1', title: 'A1', time: now },
    { url: 'https://a.com/2', title: 'A2', time: now },
    { url: 'https://b.com/', title: 'B', time: now },
  ];
  const t = topSites(h, 8);
  assert.equal(t[0].url, 'https://a.com/');
  assert.equal(t.length, 2);
});
