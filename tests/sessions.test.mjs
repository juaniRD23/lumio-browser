// Sessions with each tab's back/forward history (main/sessions.js, the
// session parts of main/tabs.js), "Restore pages?" after a crash, the bars
// over the page (main/infobars.js), the default-browser bar
// (main/default-browser.js) and the sad tab's Reload (main/sad-tab.js).
// Real TabManagers on a stand-in Electron (tests/fake-tabs.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeStore, makeWindow, browse, settle } from './fake-tabs.mjs';

const require = createRequire(import.meta.url);
const sessions = require('../main/sessions.js');
const { Infobars } = require('../main/infobars.js');
const defaultBrowser = require('../main/default-browser.js');
const { reloadCrashed } = require('../main/sad-tab.js');
const { TabStrip } = require('../main/tab-strip.js');

const world = () => ({ store: makeStore(), windows: [], closed: [] });
const urls = (h) => h.entries.map((e) => e.url);
const errorPage = (url, code = '-105') => 'lumio://error/?' + new URLSearchParams({ code, desc: 'X', url });

test('a tab’s history is kept like Chrome: 6 pages each side, failed pages as their address, damaged data tidied', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ url: `https://a.example/${i}`, title: `Page ${i}` }));
  const h = sessions.trimHistory(list, 10);
  assert.deepEqual(urls(h), Array.from({ length: 13 }, (_, i) => `https://a.example/${i + 4}`));
  assert.equal(h.entries[h.index].url, 'https://a.example/10');
  assert.equal(sessions.trimHistory(list, 99).index, 6, 'a bad index means the newest page');

  // An error page stands for the address that failed (and isn't kept twice).
  const failed = sessions.trimHistory([
    { url: 'https://a.example/' },
    { url: 'https://down.example/' },
    { url: errorPage('https://down.example/') },
  ], 2);
  assert.deepEqual(urls(failed), ['https://a.example/', 'https://down.example/']);
  assert.equal(failed.index, 1);
  assert.equal(sessions.realUrl(errorPage('https://x.example/p?q=1')), 'https://x.example/p?q=1');
  assert.equal(sessions.isCrashPage(errorPage('https://x.example/', 'crashed')), true);
  assert.equal(sessions.isCrashPage(errorPage('https://x.example/')), false);

  // Scroll positions and form fields come along when they're small enough.
  const kept = sessions.trimHistory([{ url: 'https://a.example/', pageState: 'AAAA' }, { url: 'https://b.example/', pageState: 'x'.repeat(sessions.MAX_PAGE_STATE + 1) }], 1);
  assert.deepEqual(kept.entries.map((e) => e.pageState ?? null), ['AAAA', null]);

  // Whatever a damaged session file holds.
  assert.equal(sessions.trimHistory(null, 0), null);
  assert.equal(sessions.trimHistory([], 0), null);
  assert.equal(sessions.trimHistory([{ url: '' }, 42, null], 0), null);
  const odd = sessions.trimHistory([null, { url: 'https://ok.example/', title: 7 }, { url: 'x'.repeat(9000) }], 1);
  assert.deepEqual(odd, { entries: [{ url: 'https://ok.example/', title: '' }], index: 0 });
});

test('Back still works after a restart: windows save each tab’s history and restore it', async () => {
  const one = world();
  const w = makeWindow(one, { urls: ['https://a.example/1'] });
  browse(w, w.tabs.tabs[0], ['https://a.example/2', 'https://a.example/3']);
  const first = w.tabs.tabs[0].view.webContents;
  first.navigationHistory.goBack(); // on page 2, with 3 ahead
  first.emit('did-navigate', {}, 'https://a.example/2');
  const second = w.tabs.create('https://b.example/', { active: false });
  browse(w, second, ['https://b.example/next']);
  w.tabs.setPinned(second.id, true);
  const saved = JSON.parse(JSON.stringify(w.tabs.sessionTabs({ history: true }))); // through the session file
  assert.deepEqual(saved.map((t) => t.url), ['https://b.example/next', 'https://a.example/2']);
  assert.equal(saved[0].pinned, true);
  assert.deepEqual(urls(saved[1].history), ['https://a.example/1', 'https://a.example/2', 'https://a.example/3']);
  assert.equal(saved[1].history.index, 1);
  assert.equal(w.tabs.sessionTabs().some((t) => t.history), false, 'Lumio Sync’s list has no history');

  // Next launch: the tab you were on loads with its history; the other waits.
  const two = world();
  const again = makeWindow(two, { tabs: saved, active: 1 });
  await settle();
  const [pinned, tab] = again.tabs.tabs;
  const h = tab.view.webContents.navigationHistory;
  assert.equal(h.restores.length, 1, 'restored, not loaded');
  assert.deepEqual([urls(h), h.getActiveIndex(), h.canGoBack(), h.canGoForward()], [saved[1].history.entries.map((e) => e.url), 1, true, true]);
  assert.equal(pinned.view, null, 'not loaded until you look at it');
  assert.deepEqual(urls(pinned.savedHistory), ['https://b.example/', 'https://b.example/next']);
  // Its history is saved again even before it loads...
  assert.deepEqual(urls(again.tabs.sessionTabs({ history: true })[0].history), ['https://b.example/', 'https://b.example/next']);
  // ...and comes back when it does.
  again.tabs.activate(pinned.id);
  assert.equal(pinned.view.webContents.navigationHistory.canGoBack(), true);
});

test('a tab on an error page is saved as the page that failed', () => {
  const one = world();
  const w = makeWindow(one, { urls: ['https://a.example/'] });
  browse(w, w.tabs.tabs[0], [errorPage('https://down.example/')]);
  const [t] = w.tabs.sessionTabs({ history: true });
  assert.equal(t.url, 'https://down.example/');
  assert.deepEqual(urls(t.history), ['https://a.example/', 'https://down.example/']);
});

test('closed tabs keep their history, so Reopen Closed Tab brings Back with it; Duplicate copies it', async () => {
  const one = world();
  const w = makeWindow(one, { urls: ['https://a.example/1'] });
  const tab = browse(w, w.tabs.tabs[0], ['https://a.example/2']);
  w.tabs.create('https://c.example/');
  w.tabs.close(tab.id);
  const [entry] = one.closed;
  assert.equal(entry.url, 'https://a.example/2');
  assert.deepEqual(urls(entry.history), ['https://a.example/1', 'https://a.example/2']);
  const back = w.tabs.create(entry.url, { index: entry.index, title: entry.title, history: entry.history });
  assert.equal(back.view.webContents.navigationHistory.canGoBack(), true);
  assert.equal(w.tabs.tabs.indexOf(back), 0, 'where it was');

  // Duplicate: right after the tab, the same pages, and it's the tab you're on.
  const strip = new TabStrip({ alive: () => one.windows, recentlyClosed: [], siteMute: null });
  back.view.webContents.navigationHistory.goBack();
  const copy = strip.duplicate(w, [back.id]);
  await settle();
  assert.equal(w.tabs.tabs.indexOf(copy), 1);
  assert.equal(w.tabs.activeId, copy.id);
  const h = copy.view.webContents.navigationHistory;
  assert.deepEqual([urls(h), h.getActiveIndex()], [['https://a.example/1', 'https://a.example/2'], 0]);
});

test('after a crash nothing reopens by itself: "Restore pages?" offers the last session, which also waits in Recently Closed', () => {
  const last = [{ tabs: [{ url: 'https://a.example/', title: 'A' }], active: 0 }, { tabs: [{ url: 'https://b.example/', title: 'B' }], active: 0 }];
  const plan = { windows: last, urls: [] };
  assert.deepEqual(sessions.launchPlan(plan, { crashed: false, lastSession: last }), { windows: last, urls: [], offer: null, recent: [] });
  assert.deepEqual(sessions.launchPlan(plan, { crashed: true, lastSession: last }), { windows: [], urls: [], offer: last, recent: last });
  // On startup › New Tab page: the last session goes to Recently Closed.
  assert.deepEqual(sessions.launchPlan({ windows: [], urls: [] }, { lastSession: last }).recent, last);
  assert.deepEqual(sessions.launchPlan({ windows: [], urls: ['https://start.example/'] }, { crashed: true, lastSession: [] }), { windows: [], urls: ['https://start.example/'], offer: null, recent: [] });

  // The marker file: there while Lumio runs, gone after a clean quit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-marker-'));
  assert.equal(new sessions.RunMarker(dir).start(), false, 'first run: clean');
  assert.equal(new sessions.RunMarker(dir).start(), true, 'still there: it ended without quitting');
  const m = new sessions.RunMarker(dir);
  m.start();
  m.end();
  assert.equal(new sessions.RunMarker(dir).start(), false, 'a clean quit');
  fs.writeFileSync(path.join(dir, 'Lumio Running'), '999999999');
  m.end();
  assert.equal(fs.existsSync(path.join(dir, 'Lumio Running')), true, 'another run’s marker is left alone');
});

test('Restore pages? brings the crashed session back: its first window into this one, the rest as windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-crash-'));
  fs.writeFileSync(path.join(dir, 'Lumio Running'), '1'); // the last run didn't quit
  const one = world();
  const recentlyClosed = [{ kind: 'tab', url: 'https://older.example/', title: 'Older' }];
  const infobars = new Infobars();
  let menus = 0;
  const made = [];
  const s = new sessions.Sessions({ infobars, recentlyClosed, recentChanged: () => menus++, createWindow: (opts) => made.push(opts) });
  const last = [
    { tabs: [{ url: 'https://a.example/2', title: 'A', history: { entries: [{ url: 'https://a.example/1' }, { url: 'https://a.example/2' }], index: 1 } }, { url: 'https://z.example/', title: 'Z' }], active: 0 },
    { tabs: [{ url: 'https://b.example/', title: 'B' }], active: 0, maximized: true },
  ];
  const out = s.begin({ windows: last, urls: [] }, last, dir);
  assert.deepEqual(out.windows, [], 'nothing reopens by itself');
  assert.equal(recentlyClosed.length, 3, 'its windows wait in Recently Closed');

  const w = makeWindow(one); // a new tab page
  s.offerRestore(w);
  const [bar] = infobars.list(w);
  assert.deepEqual([bar.id, bar.title, bar.text, bar.actions], ['restore', 'Restore pages?', 'Lumio didn’t shut down correctly.', [{ id: 'restore', label: 'Restore', primary: true }]]);
  assert.deepEqual(w.emitted.at(-1), ['infobars', [bar]]);

  infobars.act(w, 'restore', 'restore');
  assert.deepEqual(w.tabs.tabs.map((t) => w.tabs.displayUrl(t)), ['https://a.example/2', 'https://z.example/'], 'the unused new tab made way');
  assert.equal(w.tabs.active.view.webContents.navigationHistory.canGoBack(), true, 'with its history');
  assert.deepEqual(made, [{ tabs: last[1].tabs, active: 0, groups: undefined, bounds: undefined, maximized: true }]);
  assert.deepEqual(recentlyClosed.map((e) => e.title), ['Older'], 'no longer under Recently Closed');
  assert.equal(menus, 1);
  assert.deepEqual(infobars.list(w), [], 'the bar went away');
  infobars.act(w, 'restore', 'restore'); // a second press does nothing
  assert.equal(made.length, 1);

  // Closing the bar instead keeps the session in Recently Closed.
  fs.writeFileSync(path.join(dir, 'Lumio Running'), '1');
  const kept = [];
  const s2 = new sessions.Sessions({ infobars, recentlyClosed: kept, createWindow: () => assert.fail('nothing opens') });
  s2.begin({ windows: last, urls: [] }, last, dir);
  const w2 = makeWindow(one);
  s2.offerRestore(w2);
  infobars.act(w2, 'restore', null);
  assert.equal(kept.length, 2);
  assert.equal(s2.offer, null);
});

test('Restore shows the tab that was showing, skips windows already reopened, and the crashed session survives until restored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-crash2-'));
  fs.writeFileSync(path.join(dir, 'Lumio Running'), '1');
  const one = world();
  const recentlyClosed = [];
  const infobars = new Infobars();
  const made = [];
  const s = new sessions.Sessions({ infobars, recentlyClosed, createWindow: (opts) => made.push(opts) });
  const last = [
    { tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }, { url: 'https://c.example/', title: 'C' }], active: 1 },
    { tabs: [{ url: 'https://d.example/', title: 'D' }], active: 0 },
  ];
  s.begin({ windows: last, urls: [] }, last, dir);
  // What the session file keeps alongside the new windows, until restored.
  assert.deepEqual(s.pending().map((x) => x.tabs.length), [3, 1]);
  // The second window was reopened from Recently Closed already.
  recentlyClosed.splice(recentlyClosed.findIndex((e) => e.title === 'D'), 1);
  assert.deepEqual(s.pending().map((x) => x.tabs.length), [3]);
  const w = makeWindow(one);
  s.offerRestore(w);
  infobars.act(w, 'restore', 'restore');
  assert.equal(w.tabs.displayUrl(w.tabs.active), 'https://b.example/', 'the tab that was showing shows');
  assert.equal(w.tabs.tabs.filter((t) => t.view).length, 1, 'only it loads');
  assert.deepEqual(made, [], 'the window already reopened isn’t opened twice');
  assert.deepEqual(s.pending(), [], 'restored: nothing left to keep');

  // Not restored: next launch still has it in Recently Closed (not offered again).
  const later = [];
  const s2 = new sessions.Sessions({ infobars, recentlyClosed: later, createWindow: () => assert.fail('nothing opens') });
  s2.begin({ windows: [], urls: [] }, [], dir, last);
  assert.deepEqual(later.map((e) => e.title), ['B', 'D']);
  assert.equal(s2.offer, null);
  assert.equal(s2.pending().length, 2, 'and keeps it for the launch after');
  // Clearing Recently Closed forgets it, and the bar.
  const w2 = makeWindow(one);
  s2.offer = last;
  s2.offerRestore(w2);
  later.length = 0;
  s2.forget([w2]);
  assert.deepEqual(infobars.list(w2), []);
  assert.deepEqual(s2.pending(), []);
});

test('the bars over the page: shown per window, buttons answer once, unknown ones are ignored', () => {
  const infobars = new Infobars();
  const one = world();
  const w = makeWindow(one);
  const calls = [];
  const handlers = {};
  infobars.register({ handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { handlers[c] = fn; } });
  infobars.show(w, { id: 'x', text: 'Hello', actions: [{ id: 'go', label: 'Go' }], onAction: (_w, a) => calls.push(a), onClose: () => calls.push('closed') });
  assert.deepEqual(handlers['shell:infobars'](w), [{ id: 'x', title: '', text: 'Hello', actions: [{ id: 'go', label: 'Go' }] }]);
  handlers['window:infobar'](w, { id: 'x', action: 'nope' }); // not one of its buttons: closes it
  handlers['window:infobar'](w, { id: 'x', action: 'go' }); // gone already
  assert.deepEqual(calls, ['closed']);
});

test('"Lumio isn’t your default browser": not in tests, development builds or the first run; stops after 3 closes or when turned off', () => {
  const ok = { packaged: true };
  assert.equal(defaultBrowser.shouldOffer({}, ok), true);
  assert.equal(defaultBrowser.shouldOffer({}, { ...ok, test: true }), false, 'never in tests');
  assert.equal(defaultBrowser.shouldOffer({}, { packaged: false }), false);
  assert.equal(defaultBrowser.shouldOffer({}, { ...ok, isDefault: true }), false);
  assert.equal(defaultBrowser.shouldOffer({}, { ...ok, firstRun: true }), false);
  assert.equal(defaultBrowser.shouldOffer({ defaultBrowserPrompt: false }, ok), false);
  assert.equal(defaultBrowser.shouldOffer({ defaultBrowserDismissals: 2 }, ok), true);
  assert.equal(defaultBrowser.shouldOffer({ defaultBrowserDismissals: 3 }, ok), false);

  const one = world();
  const { store } = one;
  const infobars = new Infobars();
  const handlers = {};
  defaultBrowser.register({ internalHandle: (c, _hosts, fn) => { handlers[c] = fn; }, store, infobars, alive: () => one.windows });
  let made = 0;
  for (let i = 0; i < 3; i++) {
    const w = makeWindow(one);
    defaultBrowser.offerDefaultBrowser(w, { store, infobars, makeDefault: () => made++ });
    assert.equal(infobars.list(w)[0].text, 'Lumio isn’t your default browser');
    infobars.act(w, 'default-browser', null);
  }
  assert.equal(store.settings.defaultBrowserDismissals, 3);
  assert.equal(defaultBrowser.shouldOffer(store.settings, ok), false);
  assert.deepEqual(handlers['page:default-prompt'](), { prompt: false });
  // Settings › Ask at startup turns it back on (the count starts again)...
  assert.deepEqual(handlers['page:set-default-prompt']({}, true), { prompt: true });
  assert.equal(defaultBrowser.shouldOffer(store.settings, ok), true);
  // ...Set as default answers it...
  const w = makeWindow(one);
  defaultBrowser.offerDefaultBrowser(w, { store, infobars, makeDefault: () => made++ });
  infobars.act(w, 'default-browser', 'set');
  assert.equal(made, 1);
  assert.equal(store.settings.defaultBrowserDismissals, 0, 'not a dismissal');
  // ...and turning it off hides any bar showing.
  defaultBrowser.offerDefaultBrowser(w, { store, infobars, makeDefault: () => made++ });
  assert.deepEqual(handlers['page:set-default-prompt']({}, false), { prompt: false });
  assert.deepEqual(infobars.list(w), []);
});

test('the sad tab’s Reload goes back to the page that crashed and drops the crash page', () => {
  const one = world();
  const w = makeWindow(one, { urls: ['https://a.example/'] });
  const tab = browse(w, w.tabs.tabs[0], ['https://crashy.example/', errorPage('https://crashy.example/', 'crashed')]);
  assert.equal(tab.crashed, true, 'the tab knows it crashed');
  const wc = tab.view.webContents;
  assert.equal(reloadCrashed(w, tab), true);
  wc.emit('did-navigate', {}, 'https://crashy.example/'); // the page loads again
  assert.deepEqual(urls(wc.navigationHistory), ['https://a.example/', 'https://crashy.example/']);
  assert.equal(wc.navigationHistory.getActiveIndex(), 1);
  assert.equal(tab.crashed, false);
  // Not on a crash page: nothing to do.
  assert.equal(reloadCrashed(w, tab), false);
  // A page that crashed before it was in the history loads its address again.
  const other = browse(w, w.tabs.create('https://b.example/'), [errorPage('https://never.example/', 'crashed')]);
  assert.equal(reloadCrashed(w, other), true);
  assert.equal(other.view.webContents.getURL(), 'https://never.example/');
});

test('Reload (⌘R, the toolbar, the tab menu) on a crashed tab reloads the page that crashed, not the sad-tab page', () => {
  const one = world();
  const w = makeWindow(one, { urls: ['https://a.example/'] });
  const tab = browse(w, w.tabs.tabs[0], ['https://crashy.example/', errorPage('https://crashy.example/', 'crashed')]);
  const wc = tab.view.webContents;
  w.tabs.reload();
  assert.equal(wc.reloads, 0, 'not the sad-tab page');
  assert.equal(wc.navigationHistory.getActiveIndex(), 1, 'back on the page that crashed');
  wc.emit('did-navigate', {}, 'https://crashy.example/');
  assert.equal(tab.crashed, false);
  w.tabs.reload();
  assert.equal(wc.reloads, 1, 'an ordinary tab reloads as usual');
  // The tab menu's Reload too.
  browse(w, tab, [errorPage('https://crashy.example/', 'crashed')]);
  const strip = new TabStrip({ alive: () => one.windows, recentlyClosed: [] });
  strip.run(w, 'reload', [tab.id], tab.id);
  assert.equal(wc.reloads, 1);
  assert.equal(wc.getURL(), 'https://crashy.example/');
});
