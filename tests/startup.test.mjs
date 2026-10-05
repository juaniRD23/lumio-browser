// Settings › On startup and the Home button (main/startup.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const startup = require('../main/startup.js');

test('start pages and the home page take web addresses, not searches', () => {
  assert.equal(startup.cleanUrl('example.com'), 'https://example.com/');
  assert.equal(startup.cleanUrl(' https://news.example/a?b=1 '), 'https://news.example/a?b=1');
  assert.equal(startup.cleanUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(startup.cleanUrl('file:///Users/me/start.html'), 'file:///Users/me/start.html');
  for (const bad of ['', 'what is the weather', 'javascript:alert(1)', 'lumio://settings/', 'chrome://history', 'data:text/html,hi', null]) {
    assert.equal(startup.cleanUrl(bad), null, String(bad));
  }
});

test('the start pages list is tidied: valid, no repeats, short titles, capped', () => {
  const list = startup.cleanPages([
    'example.com',
    { url: 'https://example.com/', title: 'Dupe' },
    { url: 'news.example', title: `  ${'x'.repeat(300)}  ` },
    { url: 'not an address' },
    { title: 'no url' },
    42,
  ]);
  assert.deepEqual(list.map((p) => p.url), ['https://example.com/', 'https://news.example/']);
  assert.equal(list[0].title, '');
  assert.equal(list[1].title.length, 200);
  assert.equal(startup.cleanPages('nope').length, 0);
  assert.equal(startup.cleanPages(Array.from({ length: 80 }, (_, i) => `site${i}.example`)).length, startup.MAX_PAGES);
});

test('what opens at startup follows the setting', () => {
  const session = [{ tabs: [{ url: 'https://a.example/' }], active: 0 }];
  let read = 0;
  const windows = () => { read++; return session; };
  assert.deepEqual(startup.startupPlan({ startup: 'restore' }, windows), { windows: session, urls: [] });
  assert.deepEqual(startup.startupPlan({}, windows), { windows: session, urls: [] }, 'restore is the default');
  assert.equal(read, 2);
  assert.deepEqual(startup.startupPlan({ startup: 'newtab' }, windows), { windows: [], urls: [] });
  assert.deepEqual(startup.startupPlan({ startup: 'pages', startupPages: [{ url: 'https://one.example/' }, 'two.example', 'a search'] }, windows),
    { windows: [], urls: ['https://one.example/', 'https://two.example/'] });
  assert.deepEqual(startup.startupPlan({ startup: 'pages', startupPages: [] }, windows), { windows: [], urls: [] }, 'no pages: a new tab');
  assert.equal(read, 2, 'the last session is only read when it reopens');
  assert.equal(startup.startupMode({ startup: 'bogus' }), 'restore');
});

test('Home goes to the New Tab page unless a web address was chosen', () => {
  assert.equal(startup.homeUrl({}), 'lumio://newtab/');
  assert.equal(startup.homeUrl({ homePage: 'newtab' }), 'lumio://newtab/');
  assert.equal(startup.homeUrl({ homePage: 'https://portal.example/' }), 'https://portal.example/');
  assert.equal(startup.homeUrl({ homePage: 'javascript:alert(1)' }), 'lumio://newtab/');
});
