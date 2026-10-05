// The address bar's suggestions in depth (main/omnibox.js, omnibox-answers.js,
// search-suggest.js): answers, frecency and inline autocomplete, open tabs,
// @scopes, site search, actions, zero-suggest, the clipboard link, and when
// typed text may go to the search engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { suggest, buildIndex, inlineMatch, matchActions, zeroSuggest, withWwwCom, clipboardLink, visitWeight } = require('../main/omnibox.js');
const { calculate, convert, answerFor } = require('../main/omnibox-answers.js');
const { remoteAllowed, looksPrivate, parseSuggestions, RemoteSuggest, readCapped } = require('../main/search-suggest.js');

const G = 'https://www.google.com/search?q=%s';
const DAY = 864e5;
const now = Date.now();
const visits = (url, n, { title = '', ago = 0 } = {}) => Array.from({ length: n }, (_, i) => ({ url, title, time: now - ago - i * 1000 }));

test('the calculator answers arithmetic with its own parser', () => {
  const v = (t) => calculate(t)?.answer;
  assert.equal(v('2+2*3'), '8');
  assert.equal(v('(1+2)^2'), '9');
  assert.equal(v('2**10'), '1024');
  assert.equal(v('15% of 80'), '12');
  assert.equal(v('50%'), '0.5');
  assert.equal(v('sqrt(16) + 1'), '5');
  assert.equal(v('10 / 4'), '2.5');
  assert.equal(v('2x3'), '6');
  assert.equal(v('7 × 6 ='), '42');
  assert.equal(v('0.1+0.2'), '0.3');
  assert.equal(v('-3 - -2'), '-1');
  assert.equal(v('2*pi'), String(Number((2 * Math.PI).toPrecision(12))));
  assert.equal(v('1e20*1000'), '1e+23');
  // Not sums: plain numbers, words, dates, phone numbers, addresses, code.
  for (const t of ['42', 'pi', 'e', '2024-10-04', '555-1234', '(305) 555-1234', '1/0', 'hello', '192.168.1.1', 'xbox', 'process.exit()', 'constructor', 'alert(1)', '10:30', '((((1))', '1+'.repeat(60) + '1']) {
    assert.equal(calculate(t), null, t);
  }
});

test('unit conversions for length, weight, volume, speed, time and temperature', () => {
  assert.equal(convert('10 km in miles').answer, '6.21371 mi');
  assert.equal(convert('10 km in miles').title, '10 km = 6.21371 mi');
  assert.equal(convert('100 F to C').answer, '37.7778 °C');
  assert.equal(convert('0 celsius in kelvin').answer, '273.15 K');
  assert.equal(convert('5 lb to kg').answer, '2.26796 kg');
  assert.equal(convert('1 gallon in liters').answer, '3.78541 L');
  assert.equal(convert('60 mph to km/h').answer, '96.5606 km/h');
  assert.equal(convert('90 minutes in hours').answer, '1.5 h');
  assert.equal(convert('6 ft in cm').answer, '182.88 cm');
  assert.equal(convert('10 km in kg'), null, 'different kinds');
  assert.equal(convert('5 apples to oranges'), null);
  assert.equal(convert('km to miles'), null, 'needs a number');
  assert.deepEqual(answerFor('2+2'), { title: '= 4', answer: '4' });
  assert.equal(answerFor('weather in paris'), null);
});

test('frecency: recent visits count more, and typed addresses count again', () => {
  assert.ok(visitWeight(DAY) > visitWeight(10 * DAY) && visitWeight(10 * DAY) > visitWeight(60 * DAY) && visitWeight(60 * DAY) > visitWeight(200 * DAY));
  const history = [...visits('https://a.com/', 3, { ago: 100 * DAY }), ...visits('https://b.com/', 3)];
  const idx = buildIndex(history);
  assert.ok(idx.urls.get('https://b.com/').score > idx.urls.get('https://a.com/').score, 'recent beats old');
  const typed = buildIndex([...visits('https://c.com/', 1), ...visits('https://d.com/', 1)], { 'https://c.com/': { n: 2, t: now } });
  assert.equal(typed.list[0].url, 'https://c.com/');
  assert.equal(typed.urls.get('https://c.com/').typed, 2);
  // Sites add up their pages; www. doesn't matter.
  const site = buildIndex([...visits('https://www.github.com/a', 2), ...visits('https://github.com/b', 3)]);
  assert.equal(site.hosts.get('github.com').visits, 5);
  // Typed, then redirected elsewhere on the site: still counts for the site.
  const redirected = buildIndex(visits('https://www.example.com/', 1), { 'https://example.com/': { n: 1, t: now } });
  assert.equal(redirected.hosts.get('example.com').typed, 1);
});

test('inline autocomplete: only sites typed before or visited often, from the start', () => {
  const idx = buildIndex([...visits('https://github.com/', 1, { title: 'GitHub' }), ...visits('https://github.com/anthropics', 3, { title: 'Anthropic' }), ...visits('https://gizmodo.com/', 1)],
    { 'https://github.com/': { n: 1, t: now } });
  assert.deepEqual(inlineMatch('gi', idx), { url: 'https://github.com/', title: 'GitHub', completion: 'thub.com' });
  assert.deepEqual(inlineMatch('GITH', idx)?.completion, 'ub.com', 'any case');
  assert.equal(inlineMatch('github.com', idx), null, 'nothing left to add');
  assert.equal(inlineMatch('github.com/an', idx)?.completion, 'thropics');
  assert.equal(inlineMatch('giz', idx), null, 'one visit, never typed');
  assert.equal(inlineMatch('ithub', idx), null, 'only from the start');
  for (const t of ['gi hub', 'https://gi', 'www.gi', '']) assert.equal(inlineMatch(t, idx), null, t);
  // Visited often is enough.
  assert.equal(inlineMatch('ex', buildIndex(visits('https://example.org/x', 4)))?.completion, 'ample.org');
});

test('suggestions: the completed site first, then the search, answers, actions and matches', () => {
  const history = [...visits('https://github.com/', 2, { title: 'GitHub' }), ...visits('https://news.ycombinator.com/', 1, { title: 'Hacker News' })];
  const typed = { 'https://github.com/': { n: 1, t: now } };
  const s = suggest('git', { history, typed, bookmarks: [], searchTemplate: G });
  assert.equal(s[0].inline, 'hub.com');
  assert.equal(s[0].url, 'https://github.com/');
  assert.equal(s[1].type, 'search');
  assert.equal(s.filter((r) => r.url === 'https://github.com/').length, 1, 'not twice');
  assert.equal(s.at(-1).type, 'ai');
  assert.equal(suggest('git', { history, typed, inline: false, searchTemplate: G })[0].type, 'search', 'no completion after Backspace');

  const calc = suggest('12*12', { searchTemplate: G });
  assert.deepEqual(calc[1], { type: 'answer', title: '= 144', answer: '144' });

  assert.deepEqual(suggest('clear hist', { searchTemplate: G }).find((r) => r.type === 'action'), { type: 'action', title: 'Clear browsing data', action: 'clearData' });
  assert.deepEqual(matchActions('incog').map((a) => a.action), ['incognito']);
  assert.deepEqual(matchActions('pass').map((a) => a.action), ['passwords']);
  assert.deepEqual(matchActions('set'), [], 'too short to be sure');
  assert.deepEqual(matchActions('settings for my router'), []);
});

test('open tabs are offered as Switch to this tab, instead of the same page from history', () => {
  const history = visits('https://docs.example/page', 1, { title: 'Docs page' });
  const tabs = [{ tabId: 4, windowId: 2, title: 'Docs page', url: 'https://docs.example/page' }];
  const s = suggest('docs', { history, tabs, searchTemplate: G });
  const rows = s.filter((r) => r.url === 'https://docs.example/page');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { type: 'tab', title: 'Docs page', url: 'https://docs.example/page', tabId: 4, windowId: 2 });
});

test('@tabs, @bookmarks, @history and @lumio search one kind of thing', () => {
  const history = [...visits('https://a.example/', 1, { title: 'Alpha', ago: 5000 }), ...visits('https://b.example/', 1, { title: 'Beta' })];
  const tabs = [{ tabId: 1, windowId: 1, title: 'Alpha tab', url: 'https://a.example/' }, { tabId: 2, windowId: 1, title: 'Gamma', url: 'https://g.example/' }];
  const bookmarks = [{ url: 'https://bm.example/', title: 'Bookmarked alpha' }, { url: 'https://other.example/', title: 'Other' }];
  const keywords = [{ keyword: '@tabs', scope: 'tabs', chip: 'Search tabs' }, { keyword: '@bookmarks', scope: 'bookmarks', chip: 'Search bookmarks' }, { keyword: 'yt', chip: 'Search YouTube' }];
  const o = { history, tabs, bookmarks, searchTemplate: G };
  assert.deepEqual(suggest('alpha', { ...o, mode: { scope: 'tabs' } }).map((r) => [r.type, r.tabId]), [['tab', 1]]);
  assert.equal(suggest('', { ...o, mode: { scope: 'tabs' } }).length, 2, 'every tab before typing');
  assert.deepEqual(suggest('alpha', { ...o, mode: { scope: 'bookmarks' } }).map((r) => r.url), ['https://bm.example/']);
  const h = suggest('beta', { ...o, mode: { scope: 'history' } });
  assert.deepEqual(h.map((r) => r.type), ['history', 'search']);
  assert.equal(h[1].url, 'lumio://history/?q=beta');
  assert.deepEqual(suggest('', { ...o, mode: { scope: 'history' } }).map((r) => r.url), ['https://b.example/', 'https://a.example/'], 'newest first');
  assert.deepEqual(suggest('plan my trip', { ...o, mode: { scope: 'lumio' } }), [{ type: 'ai', title: 'plan my trip' }]);
  // Typing "@t" offers @tabs; typing a shortcut offers its search.
  assert.deepEqual(suggest('@t', { ...o, keywords }).filter((r) => r.type === 'keyword').map((r) => r.keyword), ['@tabs']);
  assert.deepEqual(suggest('yt', { ...o, keywords }).find((r) => r.type === 'keyword'), { type: 'keyword', title: 'Search YouTube', keyword: 'yt' });
});

test('site search: the engine’s results, with its suggestions', () => {
  const yt = { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' };
  const s = suggest('cats', { mode: yt, remote: ['cats', 'cats funny', 'cat videos'] });
  assert.deepEqual(s.map((r) => r.url), [
    'https://www.youtube.com/results?search_query=cats',
    'https://www.youtube.com/results?search_query=cats%20funny',
    'https://www.youtube.com/results?search_query=cat%20videos',
  ]);
  assert.equal(s[0].hint, 'Search YouTube');
});

test('the search engine’s suggestions come after the best matches and before Ask Lumio', () => {
  const history = Array.from({ length: 9 }, (_, i) => visits(`https://pizza${i}.example/`, 1, { title: `Pizza place ${i}` })).flat();
  const s = suggest('pizza', { history, searchTemplate: G, remote: ['pizza near me', 'pizza dough', 'pizza', 'pizza hut', 'pizza oven', 'pizza sauce'] });
  assert.equal(s.length, 9, 'eight rows and Ask Lumio');
  assert.deepEqual(s.filter((r) => r.remote).map((r) => r.title), ['pizza near me', 'pizza dough', 'pizza hut', 'pizza oven']);
  assert.equal(s.filter((r) => r.remote)[0].url, 'https://www.google.com/search?q=pizza%20near%20me');
  assert.equal(s.at(-1).type, 'ai');
  assert.ok(s.findIndex((r) => r.remote) > s.findIndex((r) => r.type === 'history'));
});

test('zero-suggest: the pages visited most, two per site at most, not the one open', () => {
  const idx = buildIndex([...visits('https://a.com/1', 5), ...visits('https://a.com/2', 4), ...visits('https://a.com/3', 3), ...visits('https://b.com/', 2), ...visits('https://c.com/', 1)]);
  assert.deepEqual(zeroSuggest(idx).map((r) => r.url), ['https://a.com/1', 'https://a.com/2', 'https://b.com/', 'https://c.com/']);
  assert.deepEqual(zeroSuggest(idx, { exclude: 'https://a.com/1', limit: 2 }).map((r) => r.url), ['https://a.com/2', 'https://a.com/3']);
  assert.ok(zeroSuggest(idx).every((r) => r.type === 'history' && r.removable));
});

test('the clipboard link: web addresses only, never with a password in them', () => {
  assert.equal(clipboardLink(' https://example.com/a?b=1 \n'), 'https://example.com/a?b=1');
  assert.equal(clipboardLink('example.com/page'), 'https://example.com/page');
  for (const t of ['two words.com', 'just text', 'javascript:alert(1)', 'file:///etc/passwd', 'lumio://settings/', 'https://user:secret@example.com/', '', 'x'.repeat(3000)]) {
    assert.equal(clipboardLink(t), null, t);
  }
});

test('Ctrl+Enter adds www. and .com where they are missing', () => {
  assert.equal(withWwwCom('lumio'), 'www.lumio.com');
  assert.equal(withWwwCom('www.lumio'), 'www.lumio.com');
  assert.equal(withWwwCom('lumio/pricing?x=1'), 'www.lumio.com/pricing?x=1');
  assert.equal(withWwwCom('lumio.io'), 'lumio.io');
  assert.equal(withWwwCom('two words'), 'two words');
  assert.equal(withWwwCom('https://x'), 'https://x');
});

test('typed text goes to the search engine only when it is a search and not private', () => {
  assert.equal(remoteAllowed('best pizza in town'), true);
  assert.equal(remoteAllowed('best pizza', { incognito: true }), false, 'never in Incognito');
  assert.equal(remoteAllowed('best pizza', { enabled: false }), false, 'turned off in Settings');
  for (const t of ['example.com', 'https://example.com/a b', 'localhost:3000', 'my router 192.168.0.1', 'http://[::1]/', 'file:///etc', 'javascript:x', 'lumio://settings',
    '/Users/me/notes.txt', 'C:\\Windows', 'intranet/page', '@tabs mail', 'me@example.com', '4111 1111 1111 1111', 'call 305-555-0199 9',
    'password: hunter2', 'my api key = abc', 'sk-live-abcdefghijklmnop', 'ghp_abcdefghijklmnopqrstuvwx', 'Abcdef123456XYZ', '   ', 'x'.repeat(201)]) {
    assert.equal(remoteAllowed(t), false, t);
  }
  assert.equal(looksPrivate('weather tomorrow'), false);
  assert.equal(looksPrivate('iphone 15 pro max'), false);
});

test('engines’ answers become a few suggested searches', () => {
  assert.deepEqual(parseSuggestions('["piz",["pizza","pizza hut","Pizza","piz"]]', 'piz'), ['pizza', 'pizza hut']);
  // Google says what each one is: addresses are left out.
  assert.deepEqual(parseSuggestions(JSON.stringify(['yo', ['youtube', 'youtube.com', 'yoga'], [], [], { 'google:suggesttype': ['QUERY', 'NAVIGATION', 'ENTITY'] }]), 'yo'), ['youtube', 'yoga']);
  assert.deepEqual(parseSuggestions('[{"phrase":"duck"},{"phrase":"duck\\u0007 soup"}]', 'du'), ['duck', 'duck soup']);
  assert.deepEqual(parseSuggestions('["a",["1","2","3","4","5","6","7"]]', 'a').length, 5);
  for (const body of ['not json', '{}', '[1,2]', 'null']) assert.deepEqual(parseSuggestions(body, 'x'), [], body);
});

test('suggestions are fetched without cookies, cached, and can be cancelled', async () => {
  const calls = [];
  let t = 1000;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.signal.aborted) throw init.signal.reason;
    return { ok: true, text: async () => JSON.stringify(['caf', ['café', 'cafe near me']]) };
  };
  const r = new RemoteSuggest({ fetchImpl, now: () => t });
  assert.deepEqual(await r.fetch('https://s.example/?q=%s', 'café & co'), ['café', 'cafe near me']);
  assert.equal(calls[0].url, 'https://s.example/?q=caf%C3%A9%20%26%20co');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  await r.fetch('https://s.example/?q=%s', 'café & co');
  assert.equal(calls.length, 1, 'cached');
  t += 3 * 60 * 1000;
  await r.fetch('https://s.example/?q=%s', 'café & co');
  assert.equal(calls.length, 2, 'the cache expires');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(r.fetch('https://s.example/?q=%s', 'other', { signal: ac.signal }));
  const failing = new RemoteSuggest({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await failing.fetch('https://s.example/?q=%s', 'x'), []);
  const bad = new RemoteSuggest({ fetchImpl: async () => ({ ok: false, text: async () => '' }) });
  assert.deepEqual(await bad.fetch('https://s.example/?q=%s', 'x'), []);
  assert.deepEqual(await r.fetch('https://no-placeholder.example/', 'x'), []);
});

test('answers are read only up to a size, so a site can’t make Lumio read a huge one', async () => {
  assert.equal(await readCapped(new Response('["a",["b"]]')), '["a",["b"]]');
  assert.equal(await readCapped(new Response('x'.repeat(70000))), null);
  assert.equal(await readCapped(new Response('short', { headers: { 'content-length': String(1e9) } })), null);
  assert.equal(await readCapped({ text: async () => 'plain' }), 'plain', 'a stand-in without a stream');
  const huge = new RemoteSuggest({ fetchImpl: async () => new Response(`["q",["${'x'.repeat(70000)}"]]`) });
  assert.deepEqual(await huge.fetch('https://s.example/?q=%s', 'q'), []);
});
