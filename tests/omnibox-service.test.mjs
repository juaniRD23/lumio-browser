// The address bar's main-process side (main/omnibox-service.js) with a
// stand-in for Electron: opening what was picked (and learning typed
// addresses), switching tabs across windows, the search engine's
// suggestions, "Link you copied", removing history, actions, IPC, and
// OpenSearch engines found on pages.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Electron, as far as the service uses it.
const fake = {
  clip: '',
  reads: 0,
  writes: [],
  menus: [],
  quitHandlers: [],
};
const electron = {
  app: { on: (ev, fn) => { if (ev === 'before-quit') fake.quitHandlers.push(fn); } },
  clipboard: { readText: () => { fake.reads++; return fake.clip; }, writeText: (t) => fake.writes.push(t) },
  Menu: { buildFromTemplate: (items) => ({ popup: () => fake.menus.push(items) }) },
};
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: electron };
const { OmniboxService } = require('../main/omnibox-service.js');
const { Store } = require('../main/store.js');

const now = Date.now();
let dir, store, svc, wins, opened, internal, cmdCalls, fetches;

function makeWin(id, { incognito = false, tabs = [], active = tabs[0]?.id } = {}) {
  const emitted = [];
  const w = {
    id, incognito, emitted, focused: 0, hidden: 0,
    tabs: {
      tabs,
      activeId: active,
      get active() { return tabs.find((t) => t.id === this.activeId) || null; },
      get: (tid) => tabs.find((t) => t.id === tid) || null,
      displayUrl: (t) => (t.url === 'lumio://newtab/' ? '' : t.url),
      navigated: [],
      navigate(u) { this.navigated.push(u); },
      activate(tid) { this.activeId = tid; },
    },
    hideOverlay() { w.hidden++; },
    focus() { w.focused++; },
    emit: (c, p) => emitted.push([c, p]),
  };
  return w;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-omni-'));
  store = new Store(dir, null);
  for (let i = 0; i < 3; i++) store.historyFile.data.push({ url: 'https://github.com/', title: 'GitHub', time: now - i * 1000 });
  store.historyFile.data.push({ url: 'https://news.example/a', title: 'News A', time: now });
  opened = [];
  internal = [];
  cmdCalls = [];
  fetches = [];
  fake.clip = '';
  fake.reads = 0;
  fake.writes = [];
  fake.menus = [];
  wins = [
    makeWin(1, { tabs: [{ id: 11, url: 'https://news.example/a', title: 'News A' }, { id: 12, url: 'https://docs.example/', title: 'Docs home' }] }),
    makeWin(2, { tabs: [{ id: 21, url: 'https://mail.example/', title: 'Mail inbox' }] }),
    makeWin(3, { incognito: true, tabs: [{ id: 31, url: 'https://secret.example/', title: 'Secret docs' }] }),
  ];
  const cmd = new Proxy({}, { get: (_t, k) => (k === 'clearBrowsingData' ? undefined : () => cmdCalls.push(k)) });
  svc = new OmniboxService({
    store, dir, windows: () => wins, cmd,
    openUrl: (url, disposition, w) => opened.push({ url, disposition, w: w.id }),
    openInternal: (url) => internal.push(url),
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return { ok: true, text: async () => JSON.stringify(['pizza', ['pizza near me', 'pizza dough']]) };
    },
  });
});

afterEach(() => {
  // Saves are debounced: drop them, then the profile folder.
  for (const f of [store.settingsFile, store.historyFile, store.bookmarksFile, svc.typedFile]) clearTimeout(f.timer);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Enter on a typed address opens it and remembers it was typed; searches are not remembered', () => {
  const [w] = wins;
  svc.open(w, { input: 'github.com' });
  assert.deepEqual(w.tabs.navigated, ['https://github.com/']);
  assert.equal(svc.typed['https://github.com/'].n, 1);
  svc.open(w, { input: 'best pizza' });
  assert.match(w.tabs.navigated[1], /^https:\/\/www\.google\.com\/search\?q=best%20pizza/);
  assert.equal(Object.keys(svc.typed).length, 1);
  // A picked suggestion that's a search isn't a typed address either.
  svc.open(w, { url: 'https://www.google.com/search?q=x', kind: 'search' });
  assert.equal(Object.keys(svc.typed).length, 1);
  svc.open(w, { input: 'github.com' });
  assert.equal(svc.typed['https://github.com/'].n, 2);
  // Incognito never learns.
  svc.open(wins[2], { input: 'github.com' });
  assert.equal(svc.typed['https://github.com/'].n, 2);
});

test('where it opens: a new tab, a background tab, a window (incognito stays incognito), and site search', () => {
  const [w] = wins;
  svc.open(w, { input: 'example.com', disposition: 'tab' });
  svc.open(w, { url: 'https://a.example/', kind: 'history', disposition: 'background' });
  svc.open(w, { input: 'lumio', www: true, disposition: 'window' });
  svc.open(wins[2], { input: 'example.com', disposition: 'window' });
  svc.open(w, { input: 'cute cats', keyword: 'yt' });
  svc.open(w, { input: 'x', disposition: 'nonsense' });
  assert.deepEqual(opened, [
    { url: 'https://example.com/', disposition: 'tab', w: 1 },
    { url: 'https://a.example/', disposition: 'background', w: 1 },
    { url: 'https://www.lumio.com/', disposition: 'window', w: 1 },
    { url: 'https://example.com/', disposition: 'incognito', w: 3 },
  ]);
  assert.deepEqual(w.tabs.navigated, ['https://www.youtube.com/results?search_query=cute%20cats', 'https://www.google.com/search?q=x']);
  // javascript: is never run from here: it becomes a search.
  svc.open(w, { url: 'javascript:alert(1)' });
  assert.match(w.tabs.navigated.at(-1), /^https:\/\/www\.google\.com\/search\?q=javascript/);
});

test('suggestions include open tabs in other windows of the same kind, but not the one you are on', async () => {
  const rows = await svc.suggestFor(wins[0], { text: 'docs' });
  const tabs = rows.filter((r) => r.type === 'tab');
  assert.deepEqual(tabs.map((t) => [t.windowId, t.tabId]), [[1, 12]], 'not the incognito window’s tab');
  const mail = await svc.suggestFor(wins[0], 'mail'); // older callers send just the text
  assert.ok(mail.some((r) => r.type === 'tab' && r.windowId === 2));
  const own = await svc.suggestFor(wins[0], { text: 'news' });
  assert.ok(!own.some((r) => r.type === 'tab' && r.tabId === 11), 'the active tab is left out');
  const incog = await svc.suggestFor(wins[2], { text: 'secret' });
  assert.deepEqual(incog.filter((r) => r.type === 'tab'), [], 'its own active tab only, so nothing');
  assert.ok(!(await svc.suggestFor(wins[2], { text: 'github' })).some((r) => r.type === 'history'), 'no history in incognito');
});

test('switching to a tab focuses its window, never across normal and incognito', () => {
  assert.equal(svc.switchTo(wins[0], { windowId: 2, tabId: 21 }), true);
  assert.equal(wins[1].focused, 1);
  assert.equal(svc.switchTo(wins[0], { windowId: 3, tabId: 31 }), false);
  assert.equal(svc.switchTo(wins[0], { windowId: 1, tabId: 999 }), false);
  assert.equal(svc.switchTo(wins[0], { windowId: 1, tabId: 12 }), true);
  assert.equal(wins[0].tabs.activeId, 12);
  assert.equal(wins[0].focused, 0, 'same window: no focus jump');
});

test('the search engine’s suggestions: only when allowed, merged into the rows', async () => {
  const rows = await svc.suggestFor(wins[0], { text: 'pizza', remote: true });
  assert.deepEqual(rows.filter((r) => r.remote).map((r) => r.title), ['pizza near me', 'pizza dough']);
  assert.match(fetches[0].url, /^https:\/\/suggestqueries\.google\.com\/complete\/search\?client=chrome.*q=pizza$/);
  assert.equal(fetches[0].init.credentials, 'omit');
  assert.equal(await svc.suggestFor(wins[2], { text: 'pizza', remote: true }), null, 'incognito: never');
  assert.equal(await svc.suggestFor(wins[0], { text: 'github.com', remote: true }), null, 'an address: never');
  assert.equal(await svc.suggestFor(wins[0], { text: 'me@mail.com', remote: true }), null, 'private: never');
  store.setSetting('searchSuggest', false);
  assert.equal(await svc.suggestFor(wins[0], { text: 'pasta', remote: true }), null, 'turned off');
  assert.equal(fetches.length, 1);
  store.setSetting('searchSuggest', true);
  // Site search asks that site; @scopes ask nobody.
  await svc.suggestFor(wins[0], { text: 'cats', keyword: 'wiki', remote: true });
  assert.match(fetches.at(-1).url, /^https:\/\/en\.wikipedia\.org\/w\/api\.php\?action=opensearch/);
  assert.equal(await svc.suggestFor(wins[0], { text: 'cats', keyword: '@tabs', remote: true }), null);
});

test('a newer request cancels the older one', async () => {
  let release;
  svc.remote.fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
    release = () => resolve({ ok: true, text: async () => '["q",["one"]]' });
  });
  const first = svc.suggestFor(wins[0], { text: 'first query', remote: true });
  const second = svc.suggestFor(wins[0], { text: 'second query', remote: true });
  assert.equal(await first, null, 'replaced');
  release();
  assert.ok((await second).some((r) => r.title === 'one'));
});

test('Link you copied: read only for the empty bar, fresh links only, never in incognito', () => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    fake.clip = 'https://copied.example/page';
    assert.deepEqual(svc.zero(wins[0])[0], { type: 'clipboard', title: 'Link you copied', url: 'https://copied.example/page' });
    t += 4 * 60 * 1000;
    assert.notEqual(svc.zero(wins[0])[0]?.type, 'clipboard', 'older than 3 minutes');
    fake.clip = 'https://new.example/';
    assert.equal(svc.zero(wins[0])[0].url, 'https://new.example/', 'a new copy counts from now');
    svc.remove(wins[0], { type: 'clipboard' });
    assert.notEqual(svc.zero(wins[0])[0]?.type, 'clipboard', 'dismissed');
    fake.clip = 'not a link';
    assert.notEqual(svc.zero(wins[0])[0]?.type, 'clipboard');
    const reads = fake.reads;
    assert.deepEqual(svc.zero(wins[2]), [], 'incognito: nothing');
    assert.equal(fake.reads, reads, 'and the clipboard is not read');
    // A link already on the clipboard when Lumio started counts from launch.
    const later = new OmniboxService({ store, dir, windows: () => wins, cmd: {}, openUrl() {}, openInternal() {}, fetch: async () => ({ ok: false }) });
    later.startedAt = t - 10 * 60 * 1000;
    fake.clip = 'https://old.example/';
    assert.notEqual(later.zero(wins[0])[0]?.type, 'clipboard');
  } finally {
    Date.now = realNow;
  }
  // The rest of the empty bar's list: pages visited most, not the open one.
  assert.deepEqual(svc.zero(wins[0]).filter((r) => r.type === 'history').map((r) => r.url), ['https://github.com/']);
});

test('removing a suggestion deletes it from history and forgets it was typed', async () => {
  svc.open(wins[0], { input: 'github.com' });
  assert.equal(svc.remove(wins[0], { url: 'https://github.com/', toast: true }), true);
  assert.ok(!store.history().some((h) => h.url === 'https://github.com/'));
  assert.equal(svc.typed['https://github.com/'], undefined);
  assert.deepEqual(wins[0].emitted.at(-1), ['toast', { text: 'Removed from history' }]);
  assert.equal(svc.remove(wins[2], { url: 'https://news.example/a' }), false, 'not from incognito');
  // Clearing history forgets typed addresses whose site is gone.
  svc.open(wins[0], { input: 'news.example/a' });
  assert.ok(svc.typed['https://news.example/a']);
  store.clearHistory();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(svc.typed, {});
});

test('actions, copying an answer, paste and go, and the right-click menu', () => {
  const [w] = wins;
  for (const a of ['clearData', 'passwords', 'settings', 'incognito', 'nope']) svc.action(w, a);
  assert.deepEqual(internal, ['lumio://settings/#privacy'], 'Clear browsing data opens Settings › Privacy');
  assert.deepEqual(cmdCalls, ['passwords', 'settings', 'newIncognito']);
  fake.clip = '  https://pasted.example/x \n';
  svc.pasteAndGo(w);
  assert.deepEqual(w.tabs.navigated, ['https://pasted.example/x']);
  fake.clip = 'how tall\nis everest';
  svc.contextMenu(w, { selection: false, empty: false });
  const labels = fake.menus.at(-1).map((i) => i.label || i.role || i.type);
  assert.ok(labels.includes('Paste and Search for “how tall is everest”'));
  assert.ok(labels.includes('Manage Search Engines and Site Search…'));
  assert.equal(fake.menus.at(-1).find((i) => i.role === 'cut').enabled, false, 'nothing selected to cut');
  fake.clip = 'example.com';
  svc.contextMenu(w, { selection: true });
  assert.ok(fake.menus.at(-1).some((i) => i.label === 'Paste and Go'));
});

test('IPC: the shell’s channels and the Settings and welcome pages’ channels', async () => {
  const handlers = {};
  const pages = {};
  svc.register({
    handle: (c, fn) => { handlers[c] = fn; },
    on: (c, fn) => { handlers[c] = fn; },
    internalHandle: (c, hosts, fn) => { pages[c] = { hosts, fn }; },
  });
  assert.deepEqual(Object.keys(handlers).sort(), ['omnibox:action', 'omnibox:context', 'omnibox:copy', 'omnibox:keywords', 'omnibox:open', 'omnibox:paste-go', 'omnibox:remove', 'omnibox:suggest', 'omnibox:switch-tab', 'omnibox:zero']);
  assert.deepEqual(pages['page:search-engine-default'].hosts, ['settings', 'welcome']);
  assert.deepEqual(pages['page:search-engines'].hosts, ['settings', 'welcome']);
  assert.deepEqual(pages['page:search-engine-save'].hosts, ['settings']);
  handlers['omnibox:copy'](wins[0], '144');
  assert.deepEqual(fake.writes, ['144']);
  const saved = pages['page:search-engine-save'].fn({}, { name: 'MDN', keyword: 'mdn', url: 'https://developer.mozilla.org/search?q=%s' });
  assert.equal(saved.ok, true);
  assert.ok(saved.state.custom.some((e) => e.keyword === 'mdn'));
  assert.equal(pages['page:search-engine-save'].fn({}, { name: 'x' }).ok, false);
  const id = saved.state.custom.find((e) => e.keyword === 'mdn').id;
  assert.equal(pages['page:search-engine-default'].fn({}, id).default, id);
  assert.equal(store.settings.searchEngine, id);
  assert.equal(pages['page:search-suggest'].fn({}, false).suggest, false);
  assert.equal(pages['page:search-engine-delete'].fn({}, id).default, 'google');
  assert.ok((await handlers['omnibox:keywords']()).some((k) => k.keyword === 'yt'));
});

test('OpenSearch: an https page that describes its search adds an inactive shortcut, once', async () => {
  const listeners = {};
  const wc = (url, href) => ({
    isDestroyed: () => false,
    getURL: () => url,
    on: (ev, fn) => { listeners[ev] = fn; },
    executeJavaScriptInIsolatedWorld: async () => href,
  });
  const xml = `<OpenSearchDescription><ShortName>Recipes</ShortName><Url type="text/html" template="https://recipes.example/s?q={searchTerms}"/></OpenSearchDescription>`;
  svc.fetch = async (url, init) => { fetches.push({ url, init }); return { ok: true, text: async () => xml }; };
  const page = wc('https://recipes.example/cake', 'https://recipes.example/opensearch.xml');
  svc.watchTab(page);
  svc.watchTab(page);
  await listeners['did-finish-load']();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(store.settings.searchEnginesFound.map((e) => [e.name, e.keyword, e.url]), [['Recipes', 'recipes.example', 'https://recipes.example/s?q=%s']]);
  assert.equal(fetches[0].init.credentials, 'omit');
  await svc.detectOpenSearch(page);
  assert.equal(fetches.length, 1, 'once per site');
  await svc.detectOpenSearch(wc('http://plain.example/', 'http://plain.example/os.xml'));
  await svc.detectOpenSearch(wc('https://shop.example/', 'https://cdn.other.example/os.xml'));
  assert.equal(fetches.length, 1, 'not for http pages or another site’s file');
});
