// The extension features that don't need a running browser:
//  - main/extension-access.js: site access ("When you click the extension",
//    "On specific sites", "On all sites") and the limited copy it loads,
//    plain-word permissions and what may not work in Lumio
//  - main/extension-commands.js: keyboard shortcuts for extension commands
//  - main/extension-pack.js: Pack extension (a signed CRX3 and its key)
//  - main/extension-shims.js: chrome.alarms, chrome.sidePanel and
//    chrome.identity stand-ins (Electron is stubbed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.LUMIO_TEST = '1'; // alarms may be shorter than Chrome's 30 seconds
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-ext-'));

// Electron, for the shims: a sign-in window that the test drives.
const windows = [];
class FakeWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.destroyed = false;
    this.shown = false;
    this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: (fn) => { this.openHandler = fn; } });
    windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  show() { this.shown = true; }
  loadURL(url) { this.url = url; setImmediate(() => this.emit('ready-to-show')); return Promise.resolve(); }
  // The page went somewhere (a redirect, or a link the person clicked).
  go(url, kind = 'will-redirect') { const e = { url, preventDefault() { this.prevented = true; } }; this.webContents.emit(kind, e); return e; }
}
require.cache[require.resolve('electron')] = {
  id: 'electron', loaded: true,
  exports: { app: { getPath: () => tmp, getLocale: () => 'en-US' }, BrowserWindow: Object.assign(FakeWindow, { getFocusedWindow: () => null }) },
};

const access = require('../main/extension-access.js');
const commands = require('../main/extension-commands.js');
const { packExtension, idFromKey } = require('../main/extension-pack.js');
const shims = require('../main/extension-shims.js');

const MAC = { mac: true, win: false };
const WIN = { mac: false, win: true };

// ---------------------------------------------------------------- site access
test('sites people type are understood; patterns cover the right hosts', () => {
  assert.equal(access.normalizeSite('Example.com'), 'example.com');
  assert.equal(access.normalizeSite('https://www.example.com/path?q=1'), 'www.example.com');
  assert.equal(access.normalizeSite('*.example.com'), '*.example.com');
  assert.equal(access.normalizeSite('localhost:3000'), 'localhost');
  assert.equal(access.normalizeSite('*'), null, '"all sites" is its own choice');
  assert.equal(access.normalizeSite('not a site!'), null);
  assert.equal(access.normalizeSite(''), null);

  assert.ok(access.covers('*', 'a.com'));
  assert.ok(access.covers('*.a.com', 'b.a.com'));
  assert.ok(access.covers('*.a.com', 'a.com'));
  assert.ok(!access.covers('a.com', 'b.a.com'));
  assert.ok(!access.covers('*.a.com', 'nota.com'));
  assert.equal(access.intersectHosts('*.google.com', 'mail.google.com'), 'mail.google.com');
  assert.equal(access.intersectHosts('mail.google.com', '*.google.com'), 'mail.google.com');
  assert.equal(access.intersectHosts('a.com', 'b.com'), null);

  assert.deepEqual(access.narrowPattern('<all_urls>', ['a.com']), ['*://a.com/*']);
  assert.deepEqual(access.narrowPattern('https://*.google.com/*', ['mail.google.com', 'a.com']), ['https://mail.google.com/*']);
  assert.deepEqual(access.narrowPattern('file:///*', ['a.com']), [], 'files have their own switch');
});

const MANIFEST = {
  manifest_version: 3,
  name: 'Helper',
  version: '2.1',
  key: 'MIIBIjANBg',
  permissions: ['storage', 'tabs', '<all_urls>'],
  host_permissions: ['https://*/*'],
  optional_host_permissions: ['*://*.example.org/*'],
  content_scripts: [
    { matches: ['<all_urls>'], js: ['all.js'] },
    { matches: ['https://mail.google.com/*'], js: ['mail.js'] },
  ],
  chrome_url_overrides: { newtab: 'tab.html' },
};

test('a limited manifest only reaches the allowed sites, and keeps everything else', () => {
  const sites = access.restrictManifest(MANIFEST, { mode: 'sites', sites: ['news.com', 'https://mail.google.com/'] });
  assert.deepEqual(sites.content_scripts.map((c) => c.matches), [['*://news.com/*', '*://mail.google.com/*'], ['https://mail.google.com/*']]);
  assert.deepEqual(sites.host_permissions, ['https://news.com/*', 'https://mail.google.com/*']);
  assert.deepEqual(sites.permissions, ['storage', 'tabs', '*://news.com/*', '*://mail.google.com/*'], 'API permissions stay');
  assert.deepEqual(sites.optional_host_permissions, []);
  assert.equal(sites.key, MANIFEST.key, 'same key, so the same ID and saved data');
  assert.deepEqual(sites.chrome_url_overrides, MANIFEST.chrome_url_overrides);

  const click = access.restrictManifest(MANIFEST, { mode: 'click' });
  assert.deepEqual(click.content_scripts, [], 'page scripts that would run nowhere go');
  assert.deepEqual(click.host_permissions, []);
  assert.deepEqual(click.permissions, ['storage', 'tabs']);
  assert.equal(MANIFEST.content_scripts.length, 2, 'the original is untouched');

  // "Allow access to file URLs" still works when site access is limited.
  const files = access.restrictManifest({ content_scripts: [{ matches: ['<all_urls>'], js: ['a.js'] }, { matches: ['file:///docs/*'], js: ['b.js'] }] }, { mode: 'click', files: true });
  assert.deepEqual(files.content_scripts.map((c) => c.matches), [['file:///*'], ['file:///docs/*']]);
  assert.deepEqual(access.restrictManifest({ content_scripts: [{ matches: ['<all_urls>'] }] }, { mode: 'click' }).content_scripts, [], 'not without the switch');

  assert.ok(access.wantsSites(MANIFEST));
  assert.ok(!access.wantsSites({ permissions: ['storage'] }));
  assert.ok(access.canRestrict(MANIFEST));
  assert.ok(!access.canRestrict({ ...MANIFEST, key: undefined }), 'unpacked extensions without a key keep their access');
});

test('what an extension can do on the page you are on', () => {
  assert.equal(access.accessOn(MANIFEST, { mode: 'all' }, 'https://news.com/a'), 'granted');
  assert.equal(access.accessOn(MANIFEST, { mode: 'sites', sites: ['*.news.com'] }, 'https://www.news.com/'), 'granted');
  assert.equal(access.accessOn(MANIFEST, { mode: 'sites', sites: ['other.com'] }, 'https://news.com/'), 'withheld');
  assert.equal(access.accessOn(MANIFEST, { mode: 'click' }, 'https://news.com/'), 'withheld');
  assert.equal(access.accessOn({ content_scripts: [{ matches: ['https://only.com/*'] }] }, { mode: 'all' }, 'https://news.com/'), 'none');
  assert.equal(access.accessOn(MANIFEST, { mode: 'all' }, 'lumio://settings/'), 'none');
  assert.equal(access.accessOn(MANIFEST, { mode: 'all' }, 'not a url'), 'none');
});

test('permissions in plain words, and what may not work in Lumio', () => {
  const all = access.describePermissions(MANIFEST);
  assert.equal(all[0], 'Read and change all your data on all websites', 'the biggest one first');
  assert.ok(all.includes('Read your browsing history'));
  assert.deepEqual(access.describePermissions({ host_permissions: ['https://a.com/*'] }), ['Read and change your data on a.com']);
  assert.deepEqual(access.describePermissions({ content_scripts: [{ matches: ['https://*.a.com/*', 'https://b.com/*'] }] }), ['Read and change your data on a.com and b.com']);
  assert.deepEqual(access.describePermissions({ host_permissions: ['https://a.com/*', 'https://b.com/*', 'https://c.com/*', 'https://d.com/*'] }), ['Read and change your data on 4 sites']);
  assert.deepEqual(access.describePermissions({ permissions: ['storage'] }), []);

  const limits = access.limitations({ manifest_version: 2, permissions: ['nativeMessaging', 'declarativeNetRequest', 'storage'], optional_permissions: ['history'] });
  assert.match(limits[0], /Manifest V2/);
  assert.ok(limits.some((l) => /apps on your computer/.test(l)));
  assert.ok(limits.some((l) => /rule lists/.test(l)));
  assert.ok(limits.some((l) => /history/.test(l)));
  assert.deepEqual(access.limitations({ manifest_version: 3, permissions: ['storage', 'alarms', 'contextMenus'] }), [], 'Lumio has these');
});

test('the limited copy shares the files, and is rebuilt only when the choice changes', async () => {
  const src = path.join(tmp, 'store', 'abc', '2.1_0');
  fs.mkdirSync(path.join(src, 'js'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(src, 'js', 'all.js'), 'console.log(1)');
  fs.writeFileSync(path.join(src, 'tab.html'), '<p>tab</p>');
  const dest = src + access.RESTRICTED_SUFFIX;
  const limits = { mode: 'sites', sites: ['news.com'] };
  assert.equal(access.buildRestrictedCopy(src, dest, limits), dest);
  const copy = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  assert.deepEqual(copy.host_permissions, ['https://news.com/*']);
  assert.equal(fs.readFileSync(path.join(dest, 'js', 'all.js'), 'utf8'), 'console.log(1)');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dest, 'tab.html')).ino, fs.statSync(path.join(src, 'tab.html')).ino, 'a hard link, no extra space');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')), MANIFEST, 'the original manifest is untouched');

  fs.writeFileSync(path.join(dest, 'marker-of-this-build'), '1');
  access.buildRestrictedCopy(src, dest, limits);
  assert.ok(fs.existsSync(path.join(dest, 'marker-of-this-build')), 'unchanged: reused');
  access.buildRestrictedCopy(src, dest, { mode: 'click', sites: [] });
  assert.ok(!fs.existsSync(path.join(dest, 'marker-of-this-build')), 'changed: rebuilt');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).content_scripts, []);

  const size = await access.folderSize(src);
  assert.equal(size, fs.statSync(path.join(src, 'manifest.json')).size + 14 + 10);
});

// ---------------------------------------------------------------- shortcuts
test('shortcuts follow Chrome’s rules', () => {
  const p = commands.parse('ctrl + shift + y');
  assert.deepEqual([[...p.mods].sort(), p.key], [['Ctrl', 'Shift'], 'Y']);
  assert.equal(commands.parse('Ctrl+Shift'), null, 'no key');
  assert.equal(commands.parse('Ctrl+Y+Z'), null, 'two keys');
  assert.equal(commands.parse('Ctrl+F13'), null, 'not a key Chrome allows');

  assert.equal(commands.validate('Ctrl+Shift+Y', WIN), null);
  assert.match(commands.validate('Shift+Y', WIN), /Ctrl or Alt/);
  assert.match(commands.validate('Command+Y', WIN), /Use Ctrl or Alt/);
  assert.equal(commands.validate('Command+Shift+Y', MAC), null);
  assert.equal(commands.validate('MacCtrl+Y', MAC), null);
  assert.match(commands.validate('Shift+Y', MAC), /⌘, Control or Option/);
  assert.equal(commands.validate('MediaPlayPause', WIN), null, 'media keys need nothing');
  assert.match(commands.validate('Ctrl+MediaPlayPause', WIN), /on their own/);
  assert.match(commands.validate('nonsense', WIN), /letter, number or arrow/);
});

test('an extension’s commands: suggested keys per platform, and what the person set', () => {
  const manifest = {
    commands: {
      _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+U' } },
      'open-thing': { description: 'Open the thing', suggested_key: 'Ctrl+Shift+O' },
      'no-key': { description: 'Nothing by default' },
      bad: { description: 'Shift only', suggested_key: 'Shift+K' },
    },
  };
  assert.equal(commands.suggested(manifest.commands._execute_action, MAC), 'Command+Shift+U');
  assert.equal(commands.suggested(manifest.commands._execute_action, WIN), 'Ctrl+Shift+Y');
  assert.equal(commands.suggested(manifest.commands['open-thing'], MAC), 'Command+Shift+O', 'Chrome reads Ctrl as ⌘ on the Mac');
  assert.equal(commands.suggested(manifest.commands.bad, WIN), '', 'an invalid suggestion is dropped');

  const list = commands.commandsFor(manifest, { 'open-thing': '', 'no-key': 'Alt+Shift+N' }, WIN);
  assert.deepEqual(list.map((c) => [c.name, c.shortcut, c.action]), [
    ['_execute_action', 'Ctrl+Shift+Y', true],
    ['open-thing', '', false],
    ['no-key', 'Alt+Shift+N', false],
    ['bad', '', false],
  ]);
  assert.equal(list[0].description, 'Activate the extension');
  assert.equal(list[1].suggested, 'Ctrl+Shift+O', 'cleared, but its suggestion is remembered');
});

test('shortcuts become menu accelerators and read nicely', () => {
  assert.equal(commands.toAccelerator('Command+Shift+Y', MAC), 'Command+Shift+Y');
  assert.equal(commands.toAccelerator('MacCtrl+Shift+Y', MAC), 'Control+Shift+Y');
  assert.equal(commands.toAccelerator('Ctrl+Alt+Period', WIN), 'Ctrl+Alt+.');
  assert.equal(commands.toAccelerator('MediaPrevTrack', WIN), 'MediaPreviousTrack');
  assert.equal(commands.toAccelerator('junk', WIN), null);
  assert.equal(commands.canonical('CmdOrCtrl+Shift+Y', MAC), commands.canonical('Shift+Command+Y', MAC));
  assert.equal(commands.canonical('CmdOrCtrl+Shift+Y', WIN), commands.canonical('Ctrl+Shift+Y', WIN));
  assert.notEqual(commands.canonical('Cmd+Y', MAC), commands.canonical('Ctrl+Y', MAC));
  assert.equal(commands.canonical('CmdOrCtrl+Plus', MAC), commands.canonical('Command+Plus', MAC));
  assert.equal(commands.label('Command+Shift+Y', MAC), '⇧⌘Y');
  assert.equal(commands.label('MacCtrl+Alt+Up', MAC), '⌃⌥↑');
  assert.equal(commands.label('Ctrl+Shift+Comma', WIN), 'Ctrl+Shift+,');
  assert.equal(commands.label('', WIN), '');
});

// ---------------------------------------------------------------- pack
// Reads the length-delimited fields of a protobuf message.
function protoFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => { let n = 0; let shift = 0; for (;;) { const b = buf[i++]; n += (b & 0x7f) * 2 ** shift; if (b < 0x80) return n; shift += 7; } };
  while (i < buf.length) {
    const tag = varint();
    assert.equal(tag & 7, 2, 'only length-delimited fields');
    const len = varint();
    out.push({ field: Math.floor(tag / 8), bytes: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
}

// The files in a zip, read back from its central directory.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(zlib.crc32(data), crc, `${name}: checksum`);
    files[name] = data.toString('utf8');
    p += 46 + nameLen;
  }
  return files;
}

test('Pack extension makes a signed CRX3 and a key; the key keeps the ID', () => {
  const dir = path.join(tmp, 'my-ext');
  fs.mkdirSync(path.join(dir, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Mine', version: '1.0' }));
  fs.writeFileSync(path.join(dir, 'icons', 'a.svg'), '<svg/>'.repeat(50));
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
  const res = packExtension(dir);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.crx, `${dir}.crx`);
  assert.equal(res.pem, `${dir}.pem`);
  assert.match(res.id, /^[a-p]{32}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(res.pem).mode & 0o777, 0o600, 'only you can read the key');

  const crx = fs.readFileSync(res.crx);
  assert.equal(crx.subarray(0, 4).toString('latin1'), 'Cr24');
  assert.equal(crx.readUInt32LE(4), 3, 'CRX version 3');
  const headerLen = crx.readUInt32LE(8);
  const header = protoFields(crx.subarray(12, 12 + headerLen));
  const zipBytes = crx.subarray(12 + headerLen);
  const proof = protoFields(header.find((f) => f.field === 2).bytes);
  const publicKey = proof.find((f) => f.field === 1).bytes;
  const signature = proof.find((f) => f.field === 2).bytes;
  const signedData = header.find((f) => f.field === 10000).bytes;
  assert.equal(idFromKey(publicKey), res.id);
  assert.deepEqual(protoFields(signedData)[0].bytes, crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16), 'signed data names the CRX ID');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\x00'), size, signedData, zipBytes]);
  const key = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  assert.ok(crypto.verify('sha256', signed, key, signature), 'the signature checks out');
  assert.deepEqual(Object.keys(unzip(zipBytes)).sort(), ['icons/a.svg', 'manifest.json'], 'hidden files are left out');
  assert.equal(unzip(zipBytes)['icons/a.svg'], '<svg/>'.repeat(50));

  // Again without a key: it won't overwrite the one you have.
  const again = packExtension(dir);
  assert.equal(again.ok, false);
  assert.match(again.error, /already exists/);
  // With it: a new version keeps the ID, and no new key is written.
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Mine', version: '1.1' }));
  const next = packExtension(dir, res.pem);
  assert.equal(next.ok, true);
  assert.equal(next.id, res.id);
  assert.equal(next.pem, null);
  assert.equal(packExtension(path.join(tmp, 'nothing-here')).ok, false);
  assert.match(packExtension(dir, path.join(tmp, 'missing.pem')).error, /couldn’t be read/);
});

// ---------------------------------------------------------------- shims
test('alarms go off, repeat at least every 30 seconds, and survive a restart', async () => {
  const file = path.join(tmp, 'alarms.json');
  const fired = [];
  const alarms = new shims.Alarms(file, (id, alarm) => fired.push([id, alarm.name]));
  alarms.create('ext1', 'once', { when: Date.now() + 20 });
  alarms.create('ext1', 'every', { periodInMinutes: 0.01, delayInMinutes: 0.0005 });
  alarms.create('ext2', '', { delayInMinutes: 60 });
  assert.deepEqual(alarms.all('ext1').map((a) => a.name), ['once', 'every']);
  assert.equal(alarms.get('ext2', '').name, '');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(fired.sort(), [['ext1', 'every'], ['ext1', 'once']]);
  assert.equal(alarms.get('ext1', 'once'), undefined, 'a one-time alarm is gone after it goes off');
  assert.ok(alarms.get('ext1', 'every').scheduledTime >= Date.now() + 29_000, 'repeats no sooner than Chrome allows');

  // A restart: saved alarms come back, alarms of removed extensions don't.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['ext1', 'ext2']);
  alarms.clear('ext1');
  alarms.clear('ext2');
  fs.writeFileSync(file, JSON.stringify({ ...saved, gone: [{ name: 'x', scheduledTime: Date.now() - 1000 }] }));
  const after = [];
  const restarted = new shims.Alarms(file, (id, a) => after.push([id, a.name]));
  restarted.start((id) => id !== 'gone');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['ext1', 'ext2']);
  assert.equal(restarted.clear('ext2', ''), true);
  assert.equal(restarted.clear('ext2', 'nope'), false);
  restarted.forget('ext1');
  assert.deepEqual(restarted.all('ext1'), []);
});

test('API calls are only taken from the extension’s own pages and worker', () => {
  const page = (id, url) => ({ type: 'frame', extension: { id }, sender: { getURL: () => url } });
  const id = 'a'.repeat(32);
  assert.equal(shims.callerId(page(id, `chrome-extension://${id}/popup.html`)), id);
  assert.throws(() => shims.callerId(page(id, 'https://evil.example/')), /Not allowed/);
  assert.throws(() => shims.callerId(page(id, `chrome-extension://${'b'.repeat(32)}/x.html`)), /Not allowed/);
  assert.equal(shims.callerId({ type: 'service-worker', extension: { id }, sender: { scope: `chrome-extension://${id}/` } }), id);
  assert.throws(() => shims.callerId({ type: 'frame', sender: { getURL: () => 'x' } }), /Not allowed/);
});

// A manager with the library's router, as main/extensions.js passes it.
function fakeManager() {
  const handlers = new Map();
  const events = [];
  const tabs = [];
  const clicks = [];
  const id = 'c'.repeat(32);
  const ses = { extensions: new EventEmitter() };
  ses.extensions.getExtension = (x) => (x === id ? { id, manifest: { side_panel: { default_path: 'panel.html' } } } : null);
  const manager = {
    session: ses,
    api: ses.extensions,
    settings: {},
    storeIds: () => [id],
    hooks: { createTab: (d) => tabs.push(d) },
    ece: {
      ctx: { router: { handle: (name, fn) => handlers.set(name, fn), sendEvent: (...a) => events.push(a) } },
      api: { browserAction: { activateClick: (d) => clicks.push(d) } },
    },
  };
  const call = (name, ...args) => handlers.get(`lumio.${name}`)({ type: 'frame', extension: { id }, sender: { getURL: () => `chrome-extension://${id}/bg.html` } }, ...args);
  return { manager, handlers, events, tabs, clicks, id, call };
}

test('the stand-ins: alarms through the router, the side panel in a tab, sign-in windows', async () => {
  const f = fakeManager();
  shims.register(f.manager);
  assert.ok(['alarms.create', 'alarms.get', 'alarms.getAll', 'alarms.clear', 'alarms.clearAll', 'sidePanel.open', 'identity.launchWebAuthFlow'].every((n) => f.handlers.has(`lumio.${n}`)));
  assert.throws(() => f.handlers.get('lumio.alarms.getAll')({ type: 'frame', extension: { id: f.id }, sender: { getURL: () => 'https://site.example/' } }), /Not allowed/);

  f.call('alarms.create', 'ping', { when: Date.now() + 10 });
  assert.equal(f.call('alarms.getAll').length, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(f.events.map((e) => [e[0], e[1], e[2].name]), [[f.id, 'lumio.alarms.onAlarm', 'ping']]);
  f.manager.alarms.forget(f.id);

  // Side panel: in a new tab, from the API or (when asked) the toolbar button.
  f.call('sidePanel.open');
  assert.deepEqual(f.tabs, [{ url: `chrome-extension://${f.id}/panel.html`, active: true }]);
  f.manager.ece.api.browserAction.activateClick({ extensionId: f.id });
  assert.equal(f.clicks.length, 1, 'the button works as usual until the panel is asked for');
  f.call('sidePanel.setPanelBehavior', { openPanelOnActionClick: true });
  f.manager.ece.api.browserAction.activateClick({ extensionId: f.id });
  assert.equal(f.clicks.length, 1);
  assert.equal(f.tabs.length, 2);
  f.call('sidePanel.setOptions', { enabled: false });
  assert.throws(() => f.call('sidePanel.open'), /No side panel/);
  assert.deepEqual(f.call('sidePanel.getOptions'), { path: 'panel.html', enabled: false });

  // identity.launchWebAuthFlow: ends at https://<id>.chromiumapp.org/.
  const done = f.call('identity.launchWebAuthFlow', { url: 'https://auth.example/authorize?x=1', interactive: true });
  const win = windows.at(-1);
  await new Promise((r) => setImmediate(r));
  assert.equal(win.url, 'https://auth.example/authorize?x=1');
  assert.equal(win.shown, true, 'shown when interactive');
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.go('https://auth.example/next').prevented, undefined, 'other pages load normally');
  const last = win.go(`https://${f.id}.chromiumapp.org/cb#token=abc`);
  assert.equal(last.prevented, true, 'the redirect never loads');
  assert.equal(await done, `https://${f.id}.chromiumapp.org/cb#token=abc`);
  assert.ok(win.isDestroyed());

  const closed = f.call('identity.launchWebAuthFlow', { url: 'https://auth.example/', interactive: true });
  windows.at(-1).emit('closed');
  await assert.rejects(closed, /did not approve/);
  await assert.rejects(f.call('identity.launchWebAuthFlow', { url: 'javascript:alert(1)' }), /could not be loaded/);
});

test('events reach a service worker the router lost track of (a reload, or listeners added before it was listening)', async () => {
  const id = 'd'.repeat(32);
  const page = 'e'.repeat(32);
  const routed = [];
  const sent = [];
  const scopes = [];
  const listeners = new Map();
  const manager = {
    api: { getExtension: (x) => (x === id ? { id, manifest: { background: { service_worker: 'sw.js' } } } : x === page ? { id: x, manifest: { background: { page: 'bg.html' } } } : null) },
    session: { serviceWorkers: { startWorkerForScope: async (scope) => { scopes.push(scope); return { send: (...a) => sent.push(a) }; } } },
    ece: { ctx: { router: { listeners, sendEvent: (...a) => routed.push(a) } } },
  };
  // The router knows the worker's listener: it delivers, as before.
  listeners.set('commands.onCommand', [{ type: 'service-worker', extensionId: id }]);
  shims.sendEvent(manager, id, 'commands.onCommand', 'open-page', { id: 3 });
  assert.deepEqual(routed, [[id, 'commands.onCommand', 'open-page', { id: 3 }]]);
  // It lost track (another extension's listener doesn't count): straight to the worker, once.
  listeners.set('commands.onCommand', [{ type: 'service-worker', extensionId: 'f'.repeat(32) }]);
  shims.sendEvent(manager, id, 'commands.onCommand', 'open-page', { id: 3 });
  shims.sendEvent(manager, id, 'lumio.alarms.onAlarm', { name: 'tick' });
  await new Promise((r) => setImmediate(r));
  assert.equal(routed.length, 1);
  assert.deepEqual(scopes, [`chrome-extension://${id}/`, `chrome-extension://${id}/`]);
  assert.deepEqual(sent, [['crx-commands.onCommand', 'open-page', { id: 3 }], ['crx-lumio.alarms.onAlarm', { name: 'tick' }]]);
  // No service worker (a background page): the router, as before.
  shims.sendEvent(manager, page, 'commands.onCommand', 'go');
  assert.deepEqual(routed.at(-1), [page, 'commands.onCommand', 'go']);
  // A worker that can't start doesn't throw.
  manager.session.serviceWorkers.startWorkerForScope = async () => { throw new Error('gone'); };
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    shims.sendEvent(manager, id, 'commands.onCommand', 'open-page');
    await new Promise((r) => setImmediate(r));
  } finally { console.warn = warn; }
  assert.match(warned.join('\n'), /couldn't send commands\.onCommand/);
});
