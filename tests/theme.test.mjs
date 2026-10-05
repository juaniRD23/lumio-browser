// main/theme.js: the Appearance setting (System, Light or Dark) becomes
// nativeTheme.themeSource, incognito is always dark, and changes from the
// setting or the system reach listeners. Electron's nativeTheme is a stand-in.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Store } = require('../main/store.js');
const theme = require('../main/theme.js');

// Behaves like Electron's: themeSource decides, 'system' follows the OS.
function fakeNativeTheme(systemDark) {
  const nt = new EventEmitter();
  let source = 'system';
  Object.defineProperty(nt, 'themeSource', { get: () => source, set: (v) => { source = v; nt.emit('updated'); } });
  Object.defineProperty(nt, 'shouldUseDarkColors', { get: () => (source === 'system' ? nt.systemDark : source === 'dark') });
  nt.systemDark = systemDark;
  nt.flipSystem = (dark) => { nt.systemDark = dark; nt.emit('updated'); };
  return nt;
}

let store;
let nt;
let calls;
let stopListening = () => {};
function start({ appearance, systemDark = true } = {}) {
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-theme-')), null);
  if (appearance !== undefined) store.settingsFile.data.appearance = appearance;
  nt = fakeNativeTheme(systemDark);
  theme.init({ store, nativeTheme: nt });
  calls = 0;
  stopListening();
  stopListening = theme.onChange(() => { calls++; });
}

beforeEach(() => { delete process.env.LUMIO_TEST; delete process.env.LUMIO_APPEARANCE; });

test('System is the default and follows the computer', () => {
  start({ systemDark: false });
  assert.equal(store.settings.appearance, 'system');
  assert.equal(theme.appearance(), 'system');
  assert.equal(nt.themeSource, 'system');
  assert.equal(theme.isDark(), false);
  nt.flipSystem(true);
  assert.equal(theme.isDark(), true);
  assert.equal(calls, 1, 'listeners hear the system change');
  nt.emit('updated'); // something else changed, not light or dark
  assert.equal(calls, 1);
});

test('Light and Dark override the computer', () => {
  start({ appearance: 'light', systemDark: true });
  assert.equal(nt.themeSource, 'light');
  assert.equal(theme.isDark(), false);
  start({ appearance: 'dark', systemDark: false });
  assert.equal(nt.themeSource, 'dark');
  assert.equal(theme.isDark(), true);
  nt.flipSystem(true);
  nt.flipSystem(false);
  assert.equal(theme.isDark(), true);
  assert.equal(calls, 0);
});

test('incognito is always dark', () => {
  start({ appearance: 'light' });
  assert.equal(theme.isDark(), false);
  assert.equal(theme.isDark(true), true);
  assert.equal(theme.colors(theme.isDark(true), true).frame, '#0d0b12');
});

test('changing the setting applies it live, and bad values mean System', () => {
  start({ systemDark: true });
  store.setSetting('appearance', 'light'); // Settings, the View menu or Lumio Sync
  assert.equal(nt.themeSource, 'light');
  assert.equal(theme.isDark(), false);
  assert.equal(calls, 1);
  store.setSetting('appearance', 'dark');
  assert.equal(theme.isDark(), true);
  assert.equal(calls, 2);
  store.setSetting('appearance', 'system'); // still dark here, but the choice changed
  assert.equal(nt.themeSource, 'system');
  assert.equal(calls, 3);
  store.setSetting('panelOpen', false); // other settings don't count
  assert.equal(calls, 3);
  store.setSetting('appearance', 'sepia');
  assert.equal(theme.appearance(), 'system');
  assert.equal(nt.themeSource, 'system');
  store.settingsFile.flush();
});

test('native colors: dark matches the original palette, light is light', () => {
  assert.deepEqual(theme.colors(true), { frame: '#070708', page: '#0c0c0d', symbol: '#a8a8a8' });
  assert.equal(theme.colors(false).frame, '#f3f3f5');
  assert.equal(theme.colors(false).page, '#f3f3f5');
});

test('tests run dark under System unless they ask for light', () => {
  process.env.LUMIO_TEST = '1';
  start({ systemDark: false });
  assert.equal(nt.themeSource, 'dark');
  assert.equal(theme.appearance(), 'system');
  process.env.LUMIO_APPEARANCE = 'light';
  start({ systemDark: true });
  assert.equal(nt.themeSource, 'light');
});
