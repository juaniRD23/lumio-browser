// main/perf.js and main/task-manager.js: Memory Saver modes and "keep
// active" sites, Energy Saver, preloading, performance issue alerts, and the
// Task Manager's rows. Electron is played by small stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const perf = require('../main/perf.js');
const { buildRows, serviceLabel } = require('../main/task-manager.js');
const { Store } = require('../main/store.js');

test('Memory Saver modes map to how long a tab sits unseen', () => {
  assert.equal(perf.sleepAfter({}), 60, 'Balanced by default');
  assert.equal(perf.sleepAfter({ memorySaverMode: 'maximum' }), 15);
  assert.equal(perf.sleepAfter({ memorySaverMode: 'moderate' }), 240);
  assert.equal(perf.sleepAfter({ memorySaver: false, memorySaverMode: 'maximum' }), null);
  // The older "Sleep tabs after" setting becomes the nearest mode.
  assert.equal(perf.memorySaverMode({ memorySaverMinutes: 15 }), 'maximum');
  assert.equal(perf.memorySaverMode({ memorySaverMinutes: 30 }), 'maximum');
  assert.equal(perf.memorySaverMode({ memorySaverMinutes: 60 }), 'balanced');
  assert.equal(perf.memorySaverMode({ memorySaverMinutes: 240 }), 'moderate');
  assert.equal(perf.memorySaverMode({ memorySaverMinutes: 240, memorySaverMode: 'balanced' }), 'balanced', 'a chosen mode wins');
});

test('"Always keep these sites active" takes sites however they’re typed', () => {
  assert.equal(perf.normalizeSite('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(perf.normalizeSite('*.docs.google.com'), 'docs.google.com');
  assert.equal(perf.normalizeSite('[*.]example.org'), 'example.org');
  assert.equal(perf.normalizeSite('localhost:3000'), 'localhost');
  assert.equal(perf.normalizeSite('not a site'), null);
  assert.equal(perf.normalizeSite('javascript:alert(1)'), null);
  assert.equal(perf.normalizeSite(''), null);
  const sites = ['youtube.com', 'docs.google.com'];
  assert.equal(perf.keepsActive('https://music.youtube.com/x', sites), true, 'subdomains too');
  assert.equal(perf.keepsActive('https://www.youtube.com/', sites), true);
  assert.equal(perf.keepsActive('https://notyoutube.com/', sites), false);
  assert.equal(perf.keepsActive('https://mail.google.com/', sites), false);
  assert.equal(perf.keepsActive('lumio://newtab/', sites), false);
});

// Windows with tabs, enough for PerformanceManager.
function fakeWindow(id, tabs, activeId) {
  const discarded = [];
  return {
    id, incognito: false, closed: false, profile: { guest: false, session: { preconnect: (o) => fakeWindow.preconnects.push(o.url) } },
    ai: { isRunning: () => false },
    win: { isMinimized: () => false, webContents: { on() {}, isDestroyed: () => false, executeJavaScript: async () => {} } },
    overlay: { webContents: { on() {}, isDestroyed: () => false, executeJavaScript: async () => {} } },
    emitted: [],
    emit(c, p) { this.emitted.push([c, p]); },
    tabs: {
      tabs, activeId, discarded,
      displayUrl: (t) => t.url,
      discard(tid) { const t = tabs.find((x) => x.id === tid); if (!t?.view || tid === activeId) return false; t.view = null; discarded.push(tid); return true; },
    },
  };
}
fakeWindow.preconnects = [];
const tab = (id, url, ago, extra = {}) => ({ id, url, title: `Tab ${id}`, view: { webContents: { getOSProcessId: () => 100 + id, isDestroyed: () => false, setBackgroundThrottling(on) { this.throttled = on; } } }, lastActive: Date.now() - ago * 60_000, ...extra });
const manager = (settings = {}) => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-perf-')), null);
  for (const [k, v] of Object.entries(settings)) store.setSetting(k, v);
  const wins = [];
  const toasts = [];
  const pm = new perf.PerformanceManager({ store, windows: () => wins, toast: (_w, t) => toasts.push(t) });
  return { pm, store, wins, toasts };
};

test('Memory Saver sleeps unseen tabs, never the one you’re on or a kept site', () => {
  const { pm, wins } = manager({ memorySaverMode: 'maximum', memorySaverSites: ['keep.example'] });
  const w = fakeWindow(1, [tab(1, 'https://a.example/', 30), tab(2, 'https://b.example/', 5), tab(3, 'https://www.keep.example/', 90), tab(4, 'https://c.example/', 90)], 4);
  wins.push(w);
  assert.equal(pm.sleepIdle(), 1);
  assert.deepEqual(w.tabs.discarded, [1], 'only the tab unseen for 15+ minutes that isn’t kept or active');
  pm.store.setSetting('memorySaver', false);
  w.tabs.tabs[1].lastActive = Date.now() - 3600_000;
  assert.equal(pm.sleepIdle(), 0, 'off means off');
});

test('the keep-active list is cleaned up when saved', () => {
  const { pm, store } = manager();
  pm.set('sites', ['https://www.example.com/a', 'example.com', 'bad site', 'news.example.org']);
  assert.deepEqual(store.settings.memorySaverSites, ['example.com', 'news.example.org']);
  assert.deepEqual(pm.pageState().sites, ['example.com', 'news.example.org']);
  pm.set('mode', 'moderate');
  pm.set('mode', 'extreme');
  assert.equal(pm.pageState().mode, 'moderate');
});

test('Energy Saver turns on with the battery low (or unplugged), and quiets the window', () => {
  assert.equal(perf.energySaverOn({}, { onBattery: true, level: 0.5 }), false);
  assert.equal(perf.energySaverOn({}, { onBattery: true, level: 0.2 }), true, 'at 20% or lower by default');
  assert.equal(perf.energySaverOn({}, { onBattery: false, level: 0.1 }), false, 'never while charging');
  assert.equal(perf.energySaverOn({ energySaverWhen: 'unplugged' }, { onBattery: true, level: 0.9 }), true);
  assert.equal(perf.energySaverOn({ energySaver: false }, { onBattery: true, level: 0.05 }), false);

  const { pm, wins } = manager();
  const helperTab = tab(2, 'https://b.example/', 0, { agent: { name: 'Helper 2' } });
  const w = fakeWindow(1, [tab(1, 'https://a.example/', 0), helperTab], 1);
  const ran = [];
  w.win.webContents.executeJavaScript = async (code) => ran.push(code);
  wins.push(w);
  pm.setBattery({ level: 0.15, charging: false });
  assert.equal(pm.saving, true);
  assert.match(ran.at(-1), /classList\.toggle\('energy-saver', true\)/);
  assert.deepEqual(w.emitted.at(-1), ['perf-state', { energySaver: true }]);
  assert.equal(helperTab.view.webContents.throttled, undefined, 'tabs keep Chromium’s own background throttling');
  pm.setBattery({ level: 0.15, charging: true });
  assert.equal(pm.saving, false);
  assert.match(ran.at(-1), /classList\.toggle\('energy-saver', false\)/);
});

test('Preload pages connects ahead to the highlighted suggestion, once in a while', () => {
  const payload = (items, selected = 0) => ({ kind: 'suggest', items, selected });
  assert.equal(perf.preconnectTarget(payload([{ type: 'search', url: 'https://www.google.com/search?q=cats' }])), 'https://www.google.com');
  assert.equal(perf.preconnectTarget(payload([{ type: 'search', url: 'x' }, { type: 'history', url: 'https://news.example/a?b' }], 1)), 'https://news.example');
  assert.equal(perf.preconnectTarget(payload([{ type: 'ai', title: 'hi' }])), null);
  assert.equal(perf.preconnectTarget(payload([{ type: 'url', url: 'http://intranet/' }])), null, 'single-word hosts are left alone');
  assert.equal(perf.preconnectTarget(payload([{ type: 'url', url: 'file:///etc/hosts' }])), null);
  assert.equal(perf.preconnectTarget({ kind: 'downloads' }), null);

  const { pm } = manager();
  fakeWindow.preconnects = [];
  const w = fakeWindow(1, [], null);
  const p = payload([{ type: 'history', url: 'https://news.example/a' }]);
  pm.preconnect(w, p);
  pm.preconnect(w, p);
  assert.deepEqual(fakeWindow.preconnects, ['https://news.example'], 'not again right away');
  pm.preconnect({ ...w, incognito: true }, payload([{ type: 'history', url: 'https://other.example/' }]));
  assert.deepEqual(fakeWindow.preconnects, ['https://news.example'], 'never from incognito');
  pm.set('preload', 'off');
  pm.preconnect(w, payload([{ type: 'history', url: 'https://third.example/' }]));
  assert.deepEqual(fakeWindow.preconnects, ['https://news.example'], 'No preloading means none');
});

test('a background tab using lots of memory, or CPU twice in a row, is a performance issue', () => {
  const GB = 1024 ** 3;
  const bg = (pid, memory, cpu, more = {}) => ({ pid, memory, cpu, tabs: [{ active: false, audible: false, ...more }] });
  let r = perf.findIssues([bg(1, 2 * GB, 0), bg(2, 100, 95), bg(3, 2 * GB, 0, { active: true }), bg(4, 2 * GB, 0, { audible: true }), { pid: 5, memory: 3 * GB, cpu: 99, tabs: [] }]);
  assert.deepEqual(r.heavy.map((p) => p.pid), [1], 'memory right away; never the tab you’re on, one playing sound, or a non-tab');
  assert.deepEqual([...r.hot], [2]);
  r = perf.findIssues([bg(2, 100, 90)], r.hot);
  assert.deepEqual(r.heavy.map((p) => p.pid), [2], 'busy at two checks in a row');
});

test('Fix now puts the heavy tabs to sleep; Not now hides them for a while', () => {
  const { pm, wins, toasts } = manager();
  const w = fakeWindow(1, [tab(1, 'https://heavy.example/', 1), tab(2, 'https://ok.example/', 1)], 2);
  wins.push(w);
  pm.setIssue([{ w, tab: w.tabs.tabs[0], memory: 1.5 * 1024 ** 3, cpu: 3 }]);
  const alert = w.emitted.findLast(([c]) => c === 'perf-alert')[1];
  assert.equal(alert.count, 1);
  assert.equal(alert.tabs[0].host, 'heavy.example');
  assert.equal(pm.fix(w), 1);
  assert.deepEqual(w.tabs.discarded, [1]);
  assert.match(toasts.at(-1), /A tab is sleeping now, freeing about 1\.5 GB/);
  assert.equal(w.emitted.at(-1)[1], null, 'the alert goes away');

  const w2 = fakeWindow(2, [tab(3, 'https://heavy2.example/', 1)], null);
  wins.push(w2);
  pm.setIssue([{ w: w2, tab: w2.tabs.tabs[0], memory: 2e9, cpu: 0 }]);
  pm.dismiss();
  assert.equal(pm.issue, null);
  assert.ok(pm.dismissed.get('2:3') > Date.now());
});

test('a performance alert shows each profile only its own tabs', () => {
  const { pm, wins, toasts } = manager();
  const a = fakeWindow(1, [tab(1, 'https://a.example/', 1), tab(2, 'https://x.example/', 1)], 2);
  const b = fakeWindow(2, [tab(3, 'https://secret.example/', 1), tab(4, 'https://y.example/', 1)], 4);
  b.profile = { guest: false, incognito: true }; // e.g. an incognito window
  wins.push(a, b);
  pm.setIssue([{ w: a, tab: a.tabs.tabs[0], memory: 2e9, cpu: 0 }, { w: b, tab: b.tabs.tabs[0], memory: 2e9, cpu: 0 }]);
  assert.deepEqual(a.emitted.at(-1)[1].tabs.map((t) => t.host), ['a.example']);
  assert.deepEqual(b.emitted.at(-1)[1].tabs.map((t) => t.host), ['secret.example']);
  assert.equal(pm.fix(a), 1);
  assert.deepEqual(a.tabs.discarded, [1]);
  assert.deepEqual(b.tabs.discarded, [], 'Fix now in one profile leaves the others alone');
  assert.equal(a.emitted.at(-1)[1], null);
  assert.equal(b.emitted.at(-1)[1].count, 1, 'the other profile still sees its own');
  assert.match(toasts.at(-1), /A tab is sleeping now/);
  pm.dismiss(b);
  assert.equal(pm.issue, null);
});

test('Task Manager: one row per process, with what runs in it', () => {
  const metrics = [
    { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 2.345 }, memory: { workingSetSize: 200_000 } },
    { pid: 2, type: 'GPU', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 100_000 } },
    { pid: 3, type: 'Utility', serviceName: 'network.mojom.NetworkService', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 10_000 } },
    { pid: 4, type: 'Tab', cpu: { percentCPUUsage: 12 }, memory: { workingSetSize: 300_000, privateBytes: 250_000 } },
    { pid: 5, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 50_000 } },
    { pid: 6, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 40_000 } },
    { pid: 7, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 1 } },
  ];
  const owners = new Map([
    [4, [{ kind: 'tab', title: 'Mail', favicon: 'https://mail.example/i.png', wcId: 40 }, { kind: 'tab', title: 'Inbox (2)', incognito: true, wcId: 41 }]],
    [5, [{ kind: 'ui', title: 'Lumio window', wcId: 50 }]],
    [6, [{ kind: 'extension', title: 'Dark Reader', wcId: 60 }]],
  ]);
  const rows = buildRows(metrics, owners, new Map([[40, 2048], [41, 1024]]));
  const by = Object.fromEntries(rows.map((r) => [r.pid, r]));
  assert.equal(by[1].title, 'Browser');
  assert.equal(by[1].cpu, 2.3);
  assert.equal(by[1].canEnd, false, 'the browser can’t be ended');
  assert.equal(by[2].title, 'GPU process');
  assert.equal(by[3].title, 'Utility: Network Service');
  assert.equal(by[4].title, 'Tab: Mail');
  assert.deepEqual(by[4].others, ['Incognito tab: Inbox (2)']);
  assert.equal(by[4].memory, 250_000 * 1024, 'private memory when the system reports it');
  assert.equal(by[4].network, 3072, 'its pages’ network added up');
  assert.equal(by[4].canEnd, true);
  assert.equal(by[4].canFocus, true);
  assert.equal(by[4].favicon, 'https://mail.example/i.png');
  assert.equal(by[5].canEnd, false, 'Lumio’s own window can’t be ended');
  assert.equal(by[5].network, null);
  assert.equal(by[6].title, 'Extension: Dark Reader');
  assert.equal(by[6].canEnd, true);
  assert.equal(by[7].title, 'Renderer');
  assert.equal(by[7].canEnd, false);

  assert.equal(serviceLabel({ name: 'Audio Service' }), 'Audio Service');
});
