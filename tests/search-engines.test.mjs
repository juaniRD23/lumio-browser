// Search engines and site search (main/search-engines.js): the defaults,
// adding, editing, deleting and choosing the default, shortcuts and @scopes,
// and OpenSearch engines found on websites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const se = require('../main/search-engines.js');
const sync = require('../main/sync/adapters.js');

// Settings after applying a patch, like Store.setSetting would.
const apply = (settings, patch) => ({ ...settings, ...patch });

test('the built-in engines have shortcuts and suggestion URLs; YouTube and Wikipedia come ready', () => {
  const b = se.builtins();
  assert.deepEqual(b.map((e) => e.id), ['google', 'duckduckgo', 'bing', 'brave']);
  assert.ok(b.every((e) => e.builtin && e.keyword && e.url.includes('%s') && e.suggestUrl.startsWith('https://') && e.suggestUrl.includes('%s')));
  assert.equal(b.find((e) => e.id === 'google').suggestUrl.startsWith('https://suggestqueries.google.com/complete/search?client=chrome'), true);
  assert.equal(b.find((e) => e.id === 'duckduckgo').suggestUrl.startsWith('https://duckduckgo.com/ac/'), true);
  assert.equal(b.find((e) => e.id === 'bing').suggestUrl.startsWith('https://api.bing.com/osjson.aspx'), true);
  assert.equal(b.find((e) => e.id === 'brave').suggestUrl.startsWith('https://search.brave.com/api/suggest'), true);
  assert.deepEqual(se.custom({}).map((e) => e.keyword), ['yt', 'wiki']);
  assert.equal(se.defaultEngine({}).id, 'google');
  assert.equal(se.defaultEngine({ searchEngine: 'bing' }).name, 'Bing');
  assert.equal(se.defaultEngine({ searchEngine: 'gone' }).id, 'google', 'a deleted default falls back to Google');
  assert.equal(se.searchUrl(se.byId({}, 'youtube'), ' cute cats '), 'https://www.youtube.com/results?search_query=cute%20cats');
});

test('shortcuts: site search with a space, built-in domains with Tab, @scopes', () => {
  const k = se.keywords({});
  assert.deepEqual(k.filter((x) => x.scope).map((x) => x.keyword), ['@tabs', '@bookmarks', '@history', '@lumio']);
  assert.deepEqual(k.find((x) => x.keyword === 'yt'), { keyword: 'yt', id: 'youtube', chip: 'Search YouTube' });
  assert.equal(k.find((x) => x.keyword === 'google.com').tabOnly, true);
  assert.equal(se.forKeyword({}, 'YT').name, 'YouTube');
  assert.equal(se.forKeyword({}, '@tabs').scope, 'tabs');
  assert.equal(se.forKeyword({}, 'nope'), null);
});

test('adding, editing and deleting site search, and choosing any engine as the default', () => {
  let s = {};
  const bad = (entry) => se.save(s, entry).error;
  assert.match(bad({ keyword: 'x', url: 'https://x.com/?q=%s' }), /name/);
  assert.match(bad({ name: 'X', url: 'https://x.com/?q=%s' }), /shortcut/);
  assert.match(bad({ name: 'X', keyword: 'two words', url: 'https://x.com/?q=%s' }), /no spaces/);
  assert.match(bad({ name: 'X', keyword: '@x', url: 'https://x.com/?q=%s' }), /@/);
  assert.match(bad({ name: 'X', keyword: 'yt', url: 'https://x.com/?q=%s' }), /already the shortcut for YouTube/);
  assert.match(bad({ name: 'X', keyword: 'Google.com', url: 'https://x.com/?q=%s' }), /already the shortcut for Google/);
  assert.match(bad({ name: 'X', keyword: 'x', url: 'x.com/?q=%s' }), /https:\/\//);
  assert.match(bad({ name: 'X', keyword: 'x', url: 'javascript:alert(%s)' }), /https:\/\//);
  assert.match(bad({ name: 'X', keyword: 'x', url: 'https://x.com/search' }), /%s/);

  const added = se.save(s, { name: '  MDN  Docs ', keyword: 'mdn', url: 'https://developer.mozilla.org/search?q=%s' });
  assert.equal(added.ok, true);
  assert.equal(added.engine.name, 'MDN Docs');
  s = apply(s, added.settings);
  assert.deepEqual(se.custom(s).map((e) => e.keyword), ['yt', 'wiki', 'mdn'], 'the ready-made ones stay');

  const edited = se.save(s, { id: added.engine.id, name: 'MDN', keyword: 'm', url: 'https://developer.mozilla.org/en-US/search?q=%s' });
  s = apply(s, edited.settings);
  assert.deepEqual(se.custom(s).map((e) => [e.id === added.engine.id, e.keyword]), [[false, 'yt'], [false, 'wiki'], [true, 'm']], 'edited in place');
  // Editing YouTube's URL on the same site keeps its suggestions; another site drops them.
  s = apply(s, se.save(s, { id: 'youtube', name: 'YouTube', keyword: 'yt', url: 'https://www.youtube.com/results?search_query=%s&sp=x' }).settings);
  assert.ok(se.byId(s, 'youtube').suggestUrl);
  s = apply(s, se.save(s, { id: 'youtube', name: 'Tube', keyword: 'yt', url: 'https://tube.example/?q=%s' }).settings);
  assert.equal(se.byId(s, 'youtube').suggestUrl, undefined);

  s = apply(s, se.setDefault(s, added.engine.id));
  assert.equal(se.defaultEngine(s).name, 'MDN');
  assert.equal(se.setDefault(s, 'nope'), null);
  s = apply(s, se.remove(s, added.engine.id));
  assert.equal(se.defaultEngine(s).id, 'google', 'deleting the default goes back to Google');
  assert.equal(se.custom(s).some((e) => e.id === added.engine.id), false);
  // Deleting a ready-made one sticks.
  s = apply(s, se.remove(s, 'wikipedia'));
  assert.deepEqual(se.custom(s).map((e) => e.id), ['youtube']);
});

const OSDD = (template, extra = '') => `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Recipes &amp; More</ShortName>
  <Url type="text/html" method="get" template="${template}"/>
  ${extra}
</OpenSearchDescription>`;

test('OpenSearch: a site’s own search, kept only when it is https and on the same site', () => {
  const found = se.parseOpenSearch(OSDD('https://www.recipes.example/search?q={searchTerms}&amp;page={startPage?}&amp;ie={inputEncoding}',
    '<Url type="application/x-suggestions+json" template="https://api.recipes.example/suggest?q={searchTerms}"/>'), 'https://www.recipes.example/cake');
  assert.deepEqual(found, {
    name: 'Recipes & More', keyword: 'recipes.example',
    url: 'https://www.recipes.example/search?q=%s&page=&ie=UTF-8',
    suggestUrl: 'https://api.recipes.example/suggest?q=%s',
  });
  assert.equal(se.parseOpenSearch(OSDD('https://evil.example/?q={searchTerms}'), 'https://recipes.example/'), null, 'another site');
  assert.equal(se.parseOpenSearch(OSDD('http://recipes.example/?q={searchTerms}'), 'https://recipes.example/'), null, 'not https');
  assert.equal(se.parseOpenSearch(OSDD('https://recipes.example/?q={searchTerms}&key={apiKey}'), 'https://recipes.example/'), null, 'needs more than the words');
  assert.equal(se.parseOpenSearch(OSDD('https://recipes.example/browse'), 'https://recipes.example/'), null, 'no {searchTerms}');
  assert.equal(se.parseOpenSearch('<html>nope</html>', 'https://recipes.example/'), null);
  assert.equal(se.siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(se.siteOf('en.wikipedia.org'), 'wikipedia.org');
});

test('found engines wait as inactive shortcuts until turned on', () => {
  let s = {};
  const f = { name: 'Recipes', keyword: 'recipes.example', url: 'https://recipes.example/?q=%s', suggestUrl: 'https://recipes.example/s?q=%s' };
  s = apply(s, se.addFound(s, f));
  assert.equal(se.found(s).length, 1);
  assert.equal(se.forKeyword(s, 'recipes.example'), null, 'not a shortcut yet');
  assert.equal(se.addFound(s, f), null, 'only once');
  assert.equal(se.addFound(s, { ...f, keyword: 'youtube.com', url: 'https://www.youtube.com/results?q=%s' }), null, 'YouTube is already there');
  const id = se.found(s)[0].id;
  s = apply(s, se.activate(s, id));
  assert.equal(se.found(s).length, 0);
  const on = se.forKeyword(s, 'recipes.example');
  assert.equal(on.name, 'Recipes');
  assert.equal(on.suggestUrl, 'https://recipes.example/s?q=%s');
  // At most 50 are kept, newest first.
  let many = {};
  for (let i = 0; i < 60; i++) many = apply(many, se.addFound(many, { name: `S${i}`, keyword: `s${i}.example`, url: `https://s${i}.example/?q=%s` }));
  assert.equal(se.found(many).length, 50);
  assert.equal(se.found(many)[0].name, 'S59');
});

test('added engines and the suggestions setting sync to other devices; found ones stay here', () => {
  assert.ok(sync.SETTINGS.includes('searchEngines'));
  assert.ok(sync.SETTINGS.includes('searchSuggest'));
  assert.ok(!sync.SETTINGS.includes('searchEnginesFound'));
});
