// The new tab page's shortcuts (main/ntp-shortcuts.js): My shortcuts or Most
// visited sites, add / edit / remove with one level of Undo, hiding them,
// and nothing in incognito.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NtpShortcuts, normalizeUrl, MAX_CUSTOM, STARTERS } = require('../main/ntp-shortcuts.js');

// A stand-in for main/store.js: settings, and history (newest last).
function makeStore(history = []) {
  return {
    settings: {},
    setSetting(k, v) { this.settings[k] = v; },
    history: () => history,
  };
}
const visits = (...urls) => urls.flatMap(([url, n]) => Array.from({ length: n }, (_, i) => ({ url, title: url, time: 1000 + i })));
const urls = (t) => t.items.map((s) => s.url);

test('addresses: typed ones get https, anything that isn’t a web address is refused', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl(' http://news.example/a?b=1 '), 'http://news.example/a?b=1');
  assert.equal(normalizeUrl('localhost:3000'), 'https://localhost:3000/');
  for (const bad of ['', 'two words.com', 'javascript:alert(1)', 'file:///etc/passwd', 'lumio://settings', 'nodot', 'x'.repeat(3000) + '.com']) {
    assert.equal(normalizeUrl(bad), null, bad);
  }
});

test('My shortcuts start as the most visited sites, and starters when there is no history yet', () => {
  assert.deepEqual(urls(new NtpShortcuts({ store: makeStore() }).tiles()), STARTERS.map((s) => s.url));
  const store = makeStore(visits(['https://a.example/x', 3], ['https://b.example/', 5]));
  const t = new NtpShortcuts({ store }).tiles();
  assert.equal(t.mode, 'custom');
  assert.equal(t.custom, true);
  assert.equal(t.canAdd, true);
  assert.deepEqual(urls(t), ['https://b.example/', 'https://a.example/'], 'busiest first, one per site');
  assert.equal(store.settings.ntpShortcuts, undefined, 'nothing is saved until something changes');
});

test('add, edit and remove, each with Undo; the list stops following history once changed', () => {
  const history = visits(['https://a.example/', 2]);
  const store = makeStore(history);
  const sc = new NtpShortcuts({ store });
  let t = sc.put(null, { url: 'docs.example', title: '  Docs  ' });
  assert.deepEqual(t.items, [{ url: 'https://a.example/', title: 'https://a.example/' }, { url: 'https://docs.example/', title: 'Docs' }]);
  // New visits don't change My shortcuts any more.
  history.push(...visits(['https://c.example/', 9]));
  assert.deepEqual(urls(sc.tiles()), ['https://a.example/', 'https://docs.example/']);
  // A name left empty becomes the site's name.
  t = sc.put(1, { url: 'https://www.docs.example/start', title: '' });
  assert.deepEqual(t.items[1], { url: 'https://www.docs.example/start', title: 'docs.example' });
  assert.deepEqual(urls(sc.undo()), ['https://a.example/', 'https://docs.example/'], 'undo the edit');
  t = sc.remove('https://a.example/');
  assert.deepEqual(urls(t), ['https://docs.example/']);
  assert.deepEqual(urls(sc.undo()), ['https://a.example/', 'https://docs.example/'], 'undo the removal');
  assert.deepEqual(urls(sc.undo()), ['https://a.example/', 'https://docs.example/'], 'only one level');
  // Mistakes are explained, and change nothing.
  assert.match(sc.put(null, { url: 'not a site' }).error, /web address/);
  assert.match(sc.put(null, { url: 'https://docs.example/' }).error, /already/);
  assert.match(sc.put(7, { url: 'https://new.example/' }).error, /gone/);
  assert.match(sc.put(0, { url: 'https://docs.example/' }).error, /already/);
  assert.deepEqual(urls(sc.tiles()), ['https://a.example/', 'https://docs.example/']);
});

test('at most ten shortcuts; then there is no Add shortcut tile', () => {
  const sc = new NtpShortcuts({ store: makeStore() });
  sc.reset();
  for (let i = 0; sc.tiles().items.length < MAX_CUSTOM; i++) assert.ok(!sc.put(null, { url: `https://s${i}.example/` }).error);
  const t = sc.tiles();
  assert.equal(t.items.length, MAX_CUSTOM);
  assert.equal(t.canAdd, false);
  assert.match(sc.put(null, { url: 'https://one-more.example/' }).error, /up to 10/);
});

test('Most visited: removing a site hides it, and Restore default shortcuts brings it back', () => {
  const store = makeStore(visits(['https://a.example/', 5], ['https://b.example/', 3], ['https://c.example/', 1]));
  const sc = new NtpShortcuts({ store });
  let t = sc.set({ mode: 'mostVisited' });
  assert.equal(t.mode, 'mostVisited');
  assert.equal(t.custom, false);
  assert.equal(t.canAdd, false, 'only My shortcuts can be added to');
  assert.match(sc.put(null, { url: 'https://d.example/' }).error, /My shortcuts/);
  t = sc.remove('https://a.example/');
  assert.deepEqual(urls(t), ['https://b.example/', 'https://c.example/']);
  assert.deepEqual(store.settings.ntpShortcuts.blocked, ['https://a.example/']);
  t = sc.reset();
  assert.deepEqual(urls(t), ['https://a.example/', 'https://b.example/', 'https://c.example/']);
  assert.equal(t.mode, 'mostVisited', 'reset keeps the kind chosen');
  // Switching back to My shortcuts finds them as they were.
  sc.set({ mode: 'custom' });
  sc.put(null, { url: 'https://mine.example/' });
  sc.set({ mode: 'mostVisited' });
  assert.ok(!urls(sc.tiles()).includes('https://mine.example/'));
  assert.ok(urls(sc.set({ mode: 'custom' })).includes('https://mine.example/'));
});

test('Show shortcuts off hides them; bad saved data is read safely', () => {
  const store = makeStore();
  const sc = new NtpShortcuts({ store });
  assert.equal(sc.set({ hidden: true }).hidden, true);
  assert.equal(sc.undo().hidden, false);
  store.settings.ntpShortcuts = { mode: 'weird', custom: [{ url: 'https://ok.example/', title: 5 }, null, { title: 'no url' }], blocked: 'nope', hidden: 'yes' };
  const t = sc.tiles();
  assert.equal(t.mode, 'custom');
  assert.deepEqual(t.items, [{ url: 'https://ok.example/', title: '5' }]);
  assert.equal(t.hidden, true);
});

test('the new tab page’s calls: none of it in incognito', async () => {
  const handlers = {};
  const store = makeStore(visits(['https://a.example/', 1]));
  new NtpShortcuts({ store }).register({ internalHandle: (channel, hosts, fn) => { assert.deepEqual(hosts, ['newtab']); handlers[channel] = fn; } });
  assert.deepEqual(Object.keys(handlers).sort(), ['page:ntp-shortcut-remove', 'page:ntp-shortcut-save', 'page:ntp-shortcuts', 'page:ntp-shortcuts-reset', 'page:ntp-shortcuts-set', 'page:ntp-shortcuts-undo']);
  const normal = { w: { incognito: false } };
  const incognito = { w: { incognito: true } };
  assert.deepEqual(urls(await handlers['page:ntp-shortcuts'](normal)), ['https://a.example/']);
  assert.deepEqual(await handlers['page:ntp-shortcuts'](incognito), { hidden: true, items: [], incognito: true });
  await handlers['page:ntp-shortcut-save'](incognito, null, { url: 'https://secret.example/' });
  assert.equal(store.settings.ntpShortcuts, undefined, 'an incognito page can’t change them');
  await handlers['page:ntp-shortcut-save'](normal, null, { url: 'https://b.example/', title: 'B' });
  assert.deepEqual(urls(await handlers['page:ntp-shortcuts'](normal)), ['https://a.example/', 'https://b.example/']);
});
