// The menus once every batch is merged: the ⋮ menu (batch 3) lists the
// commands the other batches added, each with the shortcut the application
// menu really has, and Settings › Keyboard shortcuts (batch 7d) lists every
// command, with no keys used twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const electronPath = require.resolve('electron');
require.cache[electronPath] ??= { id: electronPath, filename: electronPath, loaded: true, exports: {} };
require.cache[electronPath].exports.Menu ??= { buildFromTemplate: (items) => items };
const { buildBrowserMenu, menuTemplate, menuModel } = require('../main/menu.js');
const sc = require('../main/shortcuts.js');

const MAC = process.platform === 'darwin';
const cmd = new Proxy({}, { get: (_t, k) => (k === 'isDev' ? false : () => {}) });
const STATE = { recentlyClosed: [{ label: 'News', index: 0 }], bookmarks: [], open() {}, edit() {}, recentHistory: [], bookmarkItems: [], profiles: [{ id: 'a', name: 'Me', current: true }] };

function flat(items, trail = []) {
  return items.flatMap((i) => [{ ...i, trail }, ...(Array.isArray(i.submenu) ? flat(i.submenu, [...trail, i.label]) : [])]);
}

test('the ⋮ menu lists every batch’s commands', () => {
  const labels = flat(buildBrowserMenu(cmd, STATE)).map((i) => i.label).filter(Boolean);
  for (const l of [
    'Share…', 'Create QR code…', 'Screenshot…', 'Install page as app…', 'Translate…', 'Reading mode', // 7b
    'Help center', 'Report an issue…', 'What’s new', 'Manage Extensions', // 7c
    'Print…', 'Task manager', // 7a
    'Search tabs…', 'History', 'News', // 4: tab search, Recently closed
    'Show reading list', 'Add tab to reading list', 'Bookmark manager', // 5
    'Safety check', 'Delete browsing data…', // 6
    'Name window…', // 7d
  ]) assert.ok(labels.includes(l), `⋮ has ${l}`);
});

test('every shortcut the ⋮ menu shows is one the application menu has', () => {
  const norm = (a) => sc.normalize(a);
  const appKeys = new Set(flat(menuTemplate(cmd, STATE)).filter((i) => i.accelerator).map((i) => norm(i.accelerator)));
  const dots = flat(buildBrowserMenu(cmd, STATE)).filter((i) => i.accel);
  assert.ok(dots.length > 10);
  for (const i of dots) assert.ok(appKeys.has(norm(i.accel)), `${[...i.trail, i.label].join(' › ')}: ${i.accel}`);
  // And the model the overlay draws keeps them.
  const { items } = menuModel(buildBrowserMenu(cmd, STATE), { mac: MAC });
  assert.ok(flat(items).some((i) => i.label === 'Search tabs…' && i.accel));
});

test('Settings › Keyboard shortcuts lists the commands of every batch, and no keys are used twice', () => {
  const template = menuTemplate(cmd, STATE);
  const list = sc.commands(template);
  const ids = new Set(list.map((c) => c.id));
  for (const id of ['new-tab', 'caret-browsing', 'name-window', 'task-manager', 'search-tabs', 'reading-mode', 'translate-page', 'share', 'create-qr-code', 'take-screenshot',
    'install-page-as-app', 'stop', 'add-tab-to-reading-list', 'show-reading-list', 'whats-new', 'version-info', 'experiments', 'report-an-issue', 'print', 'delete-browsing-data', 'open-file']) {
    assert.ok(ids.has(id), `lists ${id}`);
  }
  const keys = sc.effective(template, {}).filter((c) => c.accel).map((c) => c.accel);
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], 'no shortcut belongs to two commands');
});
