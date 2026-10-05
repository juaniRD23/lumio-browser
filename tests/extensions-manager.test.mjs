// main/extensions.js with stand-ins for Electron's extension system and the
// two libraries: pins, site access (the limited copy it loads), file access,
// the details page, keyboard shortcuts, the new tab page an extension can
// replace (and main/extensions-ui.js's puzzle menu and "Change it back?"
// question), updates from the Web Store, and what Remove forgets.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.LUMIO_TEST = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-extmgr-'));
const stub = (name, exports) => { require.cache[require.resolve(name)] = { id: name, loaded: true, exports }; };

// The library's router and APIs, as much as Lumio uses.
const routed = [];
class FakeECE extends EventEmitter {
  static handleCRXProtocol() {}
  constructor(opts) {
    super();
    const commandMap = new Map();
    this.ctx = { router: { handle() {}, sendEvent: (...a) => routed.push(a) }, store: { buildMenuItems: () => [] } };
    this.api = { commands: { commandMap }, tabs: { getTabDetails: (wc) => ({ id: wc.id }) }, browserAction: { activateClick() {} } };
    // Like the library, it hears about loads before Lumio does.
    opts.session.extensions.on('extension-loaded', (_e, ext) => commandMap.set(ext.id, Object.keys(ext.manifest.commands || {}).map((name) => ({ name, shortcut: '' }))));
    opts.session.extensions.on('extension-unloaded', (_e, ext) => commandMap.delete(ext.id));
  }
}
const uninstalled = [];
stub('electron', { app: { getPath: () => tmp, getLocale: () => 'en-US' }, session: { defaultSession: {} }, dialog: {}, BrowserWindow: { getFocusedWindow: () => null } });
stub('electron-chrome-extensions', { ElectronChromeExtensions: FakeECE });
stub('electron-chrome-web-store', {
  installChromeWebStore: async () => {},
  updateExtensions: async () => {},
  uninstallExtension: async (id, { session, extensionsPath }) => {
    uninstalled.push(id);
    session.extensions.removeExtension(id);
    fs.rmSync(path.join(extensionsPath, id), { recursive: true, force: true });
  },
});

const { ExtensionManager } = require('../main/extensions.js');
const { accessChoice, ExtensionsUI } = require('../main/extensions-ui.js');
const { idFromKey } = require('../main/extension-pack.js');

// Electron's extension system: an unpacked extension's ID comes from its folder.
const pathId = (p) => [...crypto.createHash('sha256').update(p).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
class FakeExtensions extends EventEmitter {
  constructor() { super(); this.loaded = new Map(); this.loads = []; }
  async loadExtension(p, opts = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'), 'utf8'));
    const id = manifest.key ? idFromKey(Buffer.from(manifest.key, 'base64')) : pathId(p);
    if (this.loaded.has(id)) throw new Error(`Extension ${id} is already loaded`);
    const ext = { id, path: p, manifest, name: manifest.name, version: manifest.version };
    this.loaded.set(id, ext);
    this.loads.push({ path: p, opts });
    this.emit('extension-loaded', {}, ext);
    return ext;
  }
  getAllExtensions() { return [...this.loaded.values()]; }
  getExtension(id) { return this.loaded.get(id) || null; }
  removeExtension(id) { const e = this.loaded.get(id); if (e) { this.loaded.delete(id); this.emit('extension-unloaded', {}, e); } }
}

const spki = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
const ID = idFromKey(spki);
const STORE_MANIFEST = (version) => ({
  manifest_version: 3,
  name: '__MSG_appName__',
  default_locale: 'en',
  description: 'Helps on news sites.',
  version,
  key: spki.toString('base64'),
  update_url: 'https://clients2.google.com/service/update2/crx',
  permissions: ['storage', 'tabs', 'declarativeNetRequest'],
  host_permissions: ['<all_urls>'],
  content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }],
  action: { default_title: 'Helper' },
  icons: { 16: 'icon.png' },
  commands: {
    _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } },
    toggle: { description: 'Toggle the helper' },
  },
  chrome_url_overrides: { newtab: 'tab.html' },
});
function writeExt(dir, manifest) {
  fs.mkdirSync(path.join(dir, '_locales', 'en'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'cs.js'), '// content script');
  fs.writeFileSync(path.join(dir, 'tab.html'), '<title>My tab</title>');
  fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, '_locales', 'en', 'messages.json'), JSON.stringify({ appName: { message: 'News Helper' } }));
}

const root = path.join(tmp, 'Extensions');
const UNPACKED = path.join(tmp, 'dev', 'mine');
let m;
let api;
const events = { changed: 0, commands: 0, activated: [], toasts: [] };
const store = { settings: { disabledExtensions: [], unpackedExtensions: [] }, setSetting(k, v) { this.settings[k] = v; } };

before(async () => {
  writeExt(path.join(root, ID, '1.0_0'), STORE_MANIFEST('1.0'));
  writeExt(UNPACKED, { manifest_version: 3, name: 'Dev Tool', version: '0.1', permissions: ['alarms'], content_scripts: [{ matches: ['https://example.com/*'], js: ['cs.js'] }], commands: { go: { description: 'Go', suggested_key: 'Alt+Shift+G' } } });
  api = new FakeExtensions();
  const session = { extensions: api, registerPreloadScript() {}, serviceWorkers: { startWorkerForScope: async () => {} } };
  m = new ExtensionManager({
    session,
    store,
    hooks: {
      changed: () => events.changed++,
      commandsChanged: () => events.commands++,
      activate: (id) => events.activated.push(id),
      toast: (t) => events.toasts.push(t),
      createTab() {},
    },
  });
  await m.init();
});

test('at first, every extension is pinned; new ones are not (like Chrome)', async () => {
  assert.deepEqual(store.settings.pinnedExtensions, [ID]);
  assert.equal(api.getExtension(ID).path, path.join(root, ID, '1.0_0'));
  const res = await m.loadUnpacked(UNPACKED);
  assert.equal(res.ok, true);
  assert.deepEqual(store.settings.unpackedExtensions, [UNPACKED]);
  assert.deepEqual(store.settings.pinnedExtensions, [ID]);
  assert.equal((await m.loadUnpacked(path.join(tmp, 'nope'))).ok, false);

  const list = m.list();
  assert.deepEqual(list.map((x) => [x.name, x.type, x.pinned, x.siteAccess, x.hasAction]), [
    ['Dev Tool', 'unpacked', false, 'all', false],
    ['News Helper', 'store', true, 'all', true],
  ]);
  m.setPinned(ID, false);
  m.setPinned('not-an-id', true);
  assert.deepEqual(store.settings.pinnedExtensions, []);
  m.setPinned(ID, true);
  assert.deepEqual(store.settings.pinnedExtensions, [ID]);
});

test('site access: a limited copy on chosen sites, nothing until clicked, or everywhere', async () => {
  await m.setSiteAccess(ID, { mode: 'sites', sites: ['News.com', 'not a site!', 'https://www.blog.org/x'] });
  assert.deepEqual(store.settings.extensionAccess[ID], { mode: 'sites', sites: ['news.com', 'www.blog.org'] });
  const loaded = api.getExtension(ID);
  assert.ok(loaded.path.endsWith('~lumio'), 'the limited copy runs');
  assert.deepEqual(loaded.manifest.host_permissions, ['*://news.com/*', '*://www.blog.org/*']);
  assert.equal(loaded.id, ID, 'same ID, same saved data');

  const menu = (url) => m.menu(url).find((x) => x.id === ID);
  assert.equal(menu('https://news.com/a').here, 'granted');
  const other = menu('https://other.com/');
  assert.equal(other.here, 'withheld');
  assert.equal(accessChoice(other), 'click', 'limited to other sites: it runs here only when clicked');
  assert.equal(accessChoice(menu('https://news.com/')), 'site');
  assert.equal(other.changeable, true);

  await m.setAccessForSite(ID, 'site', 'other.com');
  assert.deepEqual(store.settings.extensionAccess[ID].sites, ['news.com', 'www.blog.org', 'other.com']);
  await m.setAccessForSite(ID, 'click');
  assert.deepEqual(api.getExtension(ID).manifest.content_scripts, []);
  assert.equal(accessChoice(menu('https://news.com/')), 'click');
  await m.setAccessForSite(ID, 'all');
  assert.equal(store.settings.extensionAccess[ID], undefined);
  assert.equal(api.getExtension(ID).path, path.join(root, ID, '1.0_0'), 'everywhere: the extension itself');
  assert.equal(await m.setSiteAccess(ID, { mode: 'sometimes' }), false);

  // Unpacked extensions can't be limited (no key): they keep what they ask for.
  const dev = m.menu('https://example.com/').find((x) => x.key === UNPACKED);
  assert.equal(dev.changeable, false);
  assert.equal(dev.here, 'granted');
});

test('file access and the details page', async () => {
  await m.setFileAccess(ID, true);
  assert.deepEqual(api.loads.at(-1).opts, { allowFileAccess: true });
  const d = await m.details(ID);
  assert.equal(d.name, 'News Helper');
  assert.equal(d.fileAccess, true);
  assert.equal(d.version, '1.0');
  assert.ok(d.size > 0);
  assert.equal(d.permissions[0], 'Read and change all your data on all websites');
  assert.ok(d.limitations.some((l) => /rule lists/.test(l)));
  assert.deepEqual(d.access, { mode: 'all', sites: [], applies: true, changeable: true });
  assert.equal(d.homepage, `https://chromewebstore.google.com/detail/${ID}`);
  assert.deepEqual(d.incognito, { available: false });
  assert.deepEqual(d.commands.map((c) => c.name), ['_execute_action', 'toggle']);
  await m.setFileAccess(ID, false);
  assert.deepEqual(api.loads.at(-1).opts, { allowFileAccess: false });
  assert.equal((await m.details(UNPACKED)).access.changeable, false);
  assert.equal(await m.details('nothing'), null);
});

test('keyboard shortcuts: Chrome’s rules, no clashes, and they run the extension', () => {
  const mac = process.platform === 'darwin';
  const list = m.shortcuts();
  assert.deepEqual(list.map((x) => x.name), ['Dev Tool', 'News Helper']);
  const news = list.find((x) => x.id === ID);
  assert.equal(news.commands[0].shortcut, mac ? 'Command+Shift+Y' : 'Ctrl+Shift+Y');
  assert.equal(news.commands[0].label, mac ? '⇧⌘Y' : 'Ctrl+Shift+Y');
  assert.ok(m.activeShortcuts().some((s) => s.id === ID && s.accelerator === (mac ? 'Command+Shift+Y' : 'Ctrl+Shift+Y')));

  const dev = list.find((x) => x.name === 'Dev Tool').id;
  const reserved = new Set([mac ? 'command+t' : 'control+t']);
  assert.match(m.setShortcut(ID, 'toggle', mac ? 'Command+T' : 'Ctrl+T', reserved).error, /Lumio already uses/);
  assert.match(m.setShortcut(ID, 'toggle', 'Alt+Shift+G', reserved).error, /Dev Tool already uses it/);
  assert.match(m.setShortcut(ID, 'toggle', 'Shift+K', reserved).error, /Include/);
  assert.match(m.setShortcut(ID, 'nope', 'Alt+K', reserved).error, /isn’t on/);
  const ok = m.setShortcut(ID, 'toggle', 'Alt+Shift+K', reserved);
  assert.equal(ok.ok, true);
  assert.equal(ok.label, mac ? '⌥⇧K' : 'Alt+Shift+K');
  assert.equal(store.settings.extensionShortcuts[ID].toggle, 'Alt+Shift+K');
  assert.equal(m.ece.api.commands.commandMap.get(ID).find((c) => c.name === 'toggle').shortcut, ok.label, 'chrome.commands.getAll() tells the truth');
  assert.equal(m.setShortcut(dev, 'go', '', reserved).ok, true, 'cleared');
  assert.ok(!m.activeShortcuts().some((s) => s.id === dev));

  m.runCommand(ID, '_execute_action', null);
  assert.deepEqual(events.activated, [ID], 'the toolbar button runs');
  m.runCommand(ID, 'toggle', { id: 7, isDestroyed: () => false });
  assert.deepEqual(routed.at(-1), [ID, 'commands.onCommand', 'toggle', { id: 7 }]);
});

test('an extension can replace the new tab page', () => {
  const o = m.newTabOverride();
  assert.deepEqual(o, { id: ID, key: ID, name: 'News Helper', url: `chrome-extension://${ID}/tab.html` });
});

// A window as main/extensions-ui.js sees it.
function fakeWindow({ incognito = false, url = 'https://news.com/a' } = {}) {
  const ov = new EventEmitter();
  Object.assign(ov, { loading: false, isLoading: () => ov.loading, focus() {}, send() {} });
  const w = {
    closed: false,
    incognito,
    overlayKind: null,
    shown: [],
    emitted: [],
    navigated: [],
    win: { getContentSize: () => [1200, 800], webContents: { focus() {} } },
    overlay: { webContents: ov },
    tabs: {
      active: { id: 1, url, view: { getBounds: () => ({ x: 0, y: 84, width: 1200, height: 700 }) } },
      tabs: [],
      displayUrl: (t) => t.url,
      wc: () => ({ focus() {} }),
      navigate: (u, id) => w.navigated.push([u, id]),
    },
    showOverlay(rect, payload) { this.overlayKind = payload.kind; this.shown.push({ rect, payload }); },
    hideOverlay() { this.overlayKind = null; },
    emit(channel, payload) { this.emitted.push([channel, payload]); },
  };
  w.tabs.tabs.push(w.tabs.active);
  return w;
}

test('the puzzle-piece menu: pin, site access for the page you’re on, details', async () => {
  const w = fakeWindow();
  const opened = [];
  const ui = new ExtensionsUI({ extensions: m, store, windows: () => [w], current: () => w, openInternal: (u) => opened.push(u), menuChanged() {} });
  ui.toggleMenu(w, { right: 1100, bottom: 80 });
  const { rect, payload } = w.shown[0];
  assert.equal(payload.kind, 'extensions');
  assert.equal(payload.fresh, true, 'opens folded');
  assert.equal(rect.x + rect.width - 12, 1100, 'lines up with the puzzle piece');
  const news = payload.items.find((x) => x.id === ID);
  assert.deepEqual([news.name, news.pinned, news.here, news.choice, news.host], ['News Helper', true, 'granted', 'all', 'news.com']);
  ui.toggleMenu(w, { right: 1100, bottom: 80 });
  assert.equal(w.overlayKind, null, 'the button closes it again');
  ui.toggleMenu(w, { right: 1100, bottom: 80 });
  assert.equal(w.shown.length, 1, 'the click that closed it doesn’t open it again');

  await ui.menuAct(w, { act: 'unpin', id: ID });
  assert.deepEqual(store.settings.pinnedExtensions, []);
  await ui.menuAct(w, { act: 'pin', id: ID });
  assert.deepEqual(store.settings.pinnedExtensions, [ID]);
  await ui.menuAct(w, { act: 'access', key: ID, choice: 'site' });
  assert.deepEqual(store.settings.extensionAccess[ID], { mode: 'sites', sites: ['news.com'] });
  assert.match(w.emitted.at(-1)[1].text, /Reload the page/);
  await ui.menuAct(w, { act: 'access', key: ID, choice: 'all' });
  assert.equal(store.settings.extensionAccess[ID], undefined);

  await new Promise((r) => setTimeout(r, 320));
  ui.toggleMenu(w, { right: 1100, bottom: 80 });
  assert.equal(w.overlayKind, 'extensions');
  await ui.menuAct(w, { act: 'details', key: ID });
  assert.equal(w.overlayKind, null);
  assert.deepEqual(opened, [`lumio://extensions/?id=${ID}`]);
  ui.toggleMenu(fakeWindow({ incognito: true }));
  assert.equal(w.shown.length, 2, 'never in incognito');
});

test('an extension’s new tab page asks “Change it back?” once; Keep it and Change it back', async () => {
  const w = fakeWindow();
  w.overlay.webContents.loading = true; // a window that just opened
  const ui = new ExtensionsUI({ extensions: m, store, windows: () => [w], current: () => w, openInternal() {}, menuChanged() {} });
  const url = `chrome-extension://${ID}/tab.html`;
  assert.equal(ui.newTabUrl(w), url);
  assert.equal(ui.newTabUrl(fakeWindow({ incognito: true })), null, 'incognito keeps Lumio’s');
  assert.equal(ui.isNewTabUrl(`${url}#x`), true);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(w.shown.length, 0, 'waits for the overlay page');
  w.overlay.webContents.loading = false;
  w.overlay.webContents.emit('did-finish-load');
  assert.deepEqual(w.shown.map((s) => s.payload), [{ kind: 'ntp-override', name: 'News Helper' }]);
  ui.newTabUrl(w);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(w.shown.length, 1, 'asked once');

  await ui.ntpDecide(w, 'keep');
  assert.deepEqual(store.settings.ntpOverrideKept, [ID]);
  assert.equal(w.overlayKind, null);

  // Change it back: the extension goes off and open new tabs get Lumio's page.
  w.tabs.active.url = url;
  w.ntpPrompt = ui.override();
  await ui.ntpDecide(w, 'revert');
  assert.ok(store.settings.disabledExtensions.includes(ID));
  assert.deepEqual(w.navigated, [['lumio://newtab/', 1]]);
  assert.match(w.emitted.at(-1)[1].text, /Turned off “News Helper”/);
  ui.changed();
  assert.equal(ui.newTabUrl(w), null);
  await m.setEnabled(ID, true);
  store.settings.ntpOverrideKept = [];
});

test('a Web Store update keeps the person’s limits and clears out the old version', async () => {
  await m.setSiteAccess(ID, { mode: 'sites', sites: ['news.com'] });
  const oldCopy = api.getExtension(ID).path;
  // What electron-chrome-web-store's updater does: unpack, swap, delete the old folder.
  const next = path.join(root, ID, '1.1_0');
  writeExt(next, STORE_MANIFEST('1.1'));
  api.removeExtension(ID);
  await api.loadExtension(next);
  fs.rmSync(oldCopy, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 30));
  const now = api.getExtension(ID);
  assert.equal(now.version, '1.1');
  assert.equal(now.path, `${next}~lumio`, 'limited again');
  assert.deepEqual(fs.readdirSync(path.join(root, ID)).sort(), ['1.1_0', '1.1_0~lumio']);
  assert.ok(events.commands > 0, 'its shortcuts are put back in the menu');
});

test('Remove forgets everything set for the extension', async () => {
  m.setShortcut(ID, 'toggle', 'Alt+Shift+K');
  await m.setFileAccess(ID, true);
  await m.remove(ID);
  assert.deepEqual(uninstalled, [ID]);
  assert.equal(api.getExtension(ID), null);
  assert.deepEqual(store.settings.pinnedExtensions, []);
  assert.equal(store.settings.extensionAccess[ID], undefined);
  assert.equal(store.settings.extensionFileAccess[ID], undefined);
  assert.equal(store.settings.extensionShortcuts[ID], undefined);
  assert.equal(m.newTabOverride(), null);

  await m.remove(UNPACKED);
  assert.deepEqual(store.settings.unpackedExtensions, []);
  assert.deepEqual(m.list(), []);
});
