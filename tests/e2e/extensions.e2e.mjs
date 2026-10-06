// End-to-end tests for the extensions UX, Help and the macOS touches, in the
// real app: the puzzle-piece menu and pinned buttons, site access (Lumio's
// limited copy of a Web Store extension), keyboard shortcuts for extension
// commands, chrome.alarms from Lumio's stand-in, an extension's new tab page
// with "Change it back", Report an issue (to a stand-in Lumio server),
// lumio://version and lumio://flags-lite, the menu bar, DevTools docking and
// Handoff.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launch } from '../../scripts/launch.mjs';
const require = createRequire(import.meta.url);
const { idFromKey } = require('../../main/extension-pack.js');

const SHOTS = process.env.LUMIO_SHOTS;
const MAC = process.platform === 'darwin';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-ext-e2e-'));
const profile = path.join(tmp, 'profile');
const spki = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
const ID = idFromKey(spki); // as if it came from the Chrome Web Store
let L;
let site;
let base;
const reports = []; // what POST /api/feedback received

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await L.wait(150);
  }
};
const title = () => L.main(() => global.lumio.tabs.wc().getTitle());
const go = async (url, expectTitle) => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), url);
  if (expectTitle) assert.ok(await until(async () => (await title()).includes(expectTitle)), `page "${expectTitle}" loaded`);
};
const overlay = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
const overlayKind = () => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current));
const tabUrls = () => L.main(() => global.lumio.tabs.tabs.map((t) => t.pendingUrl || t.url));
const pinnedButtons = () => L.shell(`document.querySelectorAll('#ext-actions .ext-action').length`);
const menuItem = (id) => L.main(({ Menu }, i) => { const it = Menu.getApplicationMenu().getMenuItemById(i); return it ? { label: it.label, accelerator: it.accelerator || null } : null; }, id);

// A Web Store extension already installed in the profile (with its key, so
// Lumio can limit where it runs).
function writeStoreExtension(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Lumio Store Test',
    version: '1.0',
    description: 'Marks pages, runs commands and sets an alarm.',
    key: spki.toString('base64'),
    permissions: ['storage', 'tabs', 'alarms'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'sw.js' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }],
    action: { default_title: 'Store Test', default_popup: 'popup.html' },
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+K' } },
      'open-page': { description: 'Open the test page', suggested_key: { default: 'Alt+Shift+O' } },
    },
  }));
  fs.writeFileSync(path.join(dir, 'cs.js'), 'document.documentElement.dataset.lumioStore = "ran";');
  fs.writeFileSync(path.join(dir, 'popup.html'), '<!doctype html><title>Store popup</title><body style="width:200px;height:80px">Store popup</body>');
  // The alarm is set once (chrome.alarms is Lumio's stand-in), and opens a tab when it goes off.
  fs.writeFileSync(path.join(dir, 'sw.js'), `
    chrome.commands.onCommand.addListener((name) => chrome.tabs.create({ url: '${base}/cmd-' + name }));
    chrome.alarms.onAlarm.addListener((a) => chrome.storage.local.set({ rang: true }, () => chrome.tabs.create({ url: '${base}/alarm-' + a.name, active: false })));
    chrome.storage.local.get('rang', (r) => { if (!r.rang) chrome.alarms.create('tick', { when: Date.now() + 1500 }); });
  `);
}

before(async () => {
  site = http.createServer(async (q, r) => {
    const u = new URL(q.url, 'http://x');
    // The Lumio server's "Report an issue" route.
    if (u.pathname === '/api/feedback' && q.method === 'POST') {
      let body = '';
      for await (const c of q) body += c;
      reports.push(JSON.parse(body));
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ ok: true, id: 'fb_1' }));
      return;
    }
    if (u.pathname.startsWith('/api/')) { r.writeHead(404, { 'content-type': 'application/json' }); r.end('{}'); return; }
    const name = u.pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1><p>Some text about ${name}.</p>`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  writeStoreExtension(path.join(profile, 'Extensions', ID, '1.0_0'));
  const ntp = path.join(tmp, 'ntp-ext');
  fs.mkdirSync(ntp, { recursive: true });
  fs.writeFileSync(path.join(ntp, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Lumio NTP Test', version: '1.0', chrome_url_overrides: { newtab: 'tab.html' } }));
  fs.writeFileSync(path.join(ntp, 'tab.html'), '<!doctype html><title>Custom New Tab</title><h1>My new tab</h1>');
  L = await launch({ profile, env: { LUMIO_ACCOUNT_BASE: base } });
  await until(() => L.main(() => !!global.lumio.tabs?.active && !!global.lumio.extUi), 15_000);
  await until(() => L.main((_e, id) => !!global.lumio.extensions.api.getExtension(id), ID), 15_000);
  await L.wait(600);
});

after(async () => {
  await L?.close();
  site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the puzzle-piece menu lists extensions and pins them to the toolbar', async () => {
  // Installed before pinning existed: it stays on the toolbar.
  assert.deepEqual(await L.main(() => global.lumio.store.settings.pinnedExtensions), [ID]);
  assert.ok(await until(async () => (await pinnedButtons()) === 1));
  await go(`${base}/menu`, 'Page menu');
  await L.shell(`document.getElementById('ext-btn').click(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'extensions'), 'the menu opens');
  assert.match(await until(() => overlay(`document.querySelector('.xm')?.innerText`)), /Lumio Store Test\s+Can read and change this site/);
  await shot('ext-01-menu');
  // Unpin and pin from the menu.
  await overlay(`document.querySelector('[data-act=unpin]').click(); true`);
  assert.ok(await until(async () => (await pinnedButtons()) === 0));
  assert.deepEqual(await L.main(() => global.lumio.store.settings.pinnedExtensions), []);
  await overlay(`document.querySelector('[data-act=pin]').click(); true`);
  assert.ok(await until(async () => (await pinnedButtons()) === 1));
  // Esc closes it and gives the puzzle piece the focus back.
  await overlay(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  assert.ok(await until(async () => (await overlayKind()) === null));
  assert.ok(await until(() => L.shell(`document.activeElement.id === 'ext-btn'`)));
});

test('site access: only when clicked, on this site, or on all sites', async () => {
  await go(`${base}/access-a`, 'Page access-a');
  assert.ok(await until(() => L.page(`document.documentElement.dataset.lumioStore === 'ran'`)), 'runs everywhere at first');
  await L.main((_e, id) => global.lumio.extensions.setSiteAccess(id, { mode: 'click' }), ID);
  assert.match(await L.main((_e, id) => global.lumio.extensions.api.getExtension(id).path, ID), /~lumio$/, 'Lumio’s limited copy runs');
  await go(`${base}/access-b`, 'Page access-b');
  await L.wait(800);
  assert.equal(await L.page(`document.documentElement.dataset.lumioStore || 'none'`), 'none', 'its page script is held back');

  // The menu's quick choice for the site you're on.
  await L.shell(`document.getElementById('ext-btn').click(); true`);
  await until(async () => (await overlayKind()) === 'extensions');
  assert.match(await until(() => overlay(`document.querySelector('.xm-status')?.textContent`)), /Not allowed on this site/);
  await overlay(`document.querySelector('[data-act=more]').click(); true`);
  assert.match(await until(() => overlay(`document.querySelector('.xm-panel')?.innerText`)), /When you click the extension\s+On 127\.0\.0\.1\s+On all sites/);
  await shot('ext-02-site-access');
  await overlay(`document.querySelector('[data-choice=site]').click(); true`);
  assert.ok(await until(async () => JSON.stringify(await L.main((_e, id) => global.lumio.store.settings.extensionAccess[id], ID)) === JSON.stringify({ mode: 'sites', sites: ['127.0.0.1'] })));
  await L.main(() => global.lumio.cmd.reload(false));
  assert.ok(await until(() => L.page(`document.documentElement.dataset.lumioStore === 'ran'`)), 'runs on the allowed site after a reload');
  await L.main((_e, id) => global.lumio.extensions.setSiteAccess(id, { mode: 'all' }), ID);
  assert.ok(!(await L.main((_e, id) => global.lumio.extensions.api.getExtension(id).path, ID)).endsWith('~lumio'));
  await L.main(() => global.lumio.current.hideOverlay());
});

test('keyboard shortcuts run extension commands from the menu bar', async () => {
  const item = await until(() => menuItem(`ext-cmd:${ID}:open-page`));
  assert.equal(item.accelerator, 'Alt+Shift+O', 'the manifest’s suggestion');
  await L.main(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(`ext-cmd:${id}:open-page`).click(), ID);
  assert.ok(await until(async () => (await tabUrls()).includes(`${base}/cmd-open-page`)), 'chrome.commands.onCommand ran');
  await L.main(() => global.lumio.cmd.closeTab());
  // _execute_action opens its popup.
  await L.main(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(`ext-cmd:${id}:_execute_action`).click(), ID);
  const popup = () => L.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('/popup.html') && w.isVisible()));
  assert.ok(await until(popup), 'popup open');
  await L.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/popup.html'))?.close());

  // Changed on lumio://extensions/shortcuts: Lumio's own shortcuts are refused.
  const reserved = await L.main((_e, id) => global.lumio.extensions.setShortcut(id, 'open-page', process.platform === 'darwin' ? 'Command+T' : 'Ctrl+T', global.lumio.extUi.reservedAccelerators()), ID);
  assert.match(reserved.error, /Lumio already uses/);
  const ok = await L.main((_e, id) => global.lumio.extensions.setShortcut(id, 'open-page', 'Alt+Shift+P', global.lumio.extUi.reservedAccelerators()), ID);
  assert.equal(ok.ok, true);
  assert.ok(await until(async () => (await menuItem(`ext-cmd:${ID}:open-page`))?.accelerator === 'Alt+Shift+P'));
  await go(`lumio://extensions/shortcuts`, 'Keyboard shortcuts');
  assert.ok(await until(() => L.page(`document.querySelectorAll('.sc-box').length === 2`)));
  assert.match(await L.page(`document.getElementById('sc-list').innerText`), /Lumio Store Test[\s\S]*Open the test page/);
  await shot('ext-03-shortcuts');
});

test('chrome.alarms (Lumio’s stand-in) wakes the extension', async () => {
  assert.ok(await until(async () => (await tabUrls()).includes(`${base}/alarm-tick`), 15_000), 'the alarm went off');
});

test('the details page shows what the extension can do', async () => {
  await go(`lumio://extensions/?id=${ID}`, 'Lumio Store Test');
  const text = await until(() => L.page(`document.getElementById('view-details').innerText`));
  assert.match(text, /Lumio Store Test[\s\S]*Marks pages, runs commands and sets an alarm\.[\s\S]*1\.0/);
  assert.match(text, /Read and change all your data on all websites/);
  assert.match(text, /Allow in Incognito[\s\S]*Allow access to file URLs/);
  await shot('ext-04-details');
  await L.page(`document.getElementById('d-files').click(); true`);
  assert.ok(await until(() => L.main((_e, id) => global.lumio.store.settings.extensionFileAccess?.[id] === true, ID)));
  await L.page(`document.getElementById('d-files').click(); true`);
  await until(() => L.main((_e, id) => !global.lumio.store.settings.extensionFileAccess?.[id], ID));
});

test('an extension’s new tab page, and “Change it back”', async () => {
  const dir = path.join(path.dirname(profile), 'ntp-ext');
  const res = await L.main((_e, p) => global.lumio.extensions.loadUnpacked(p), dir);
  assert.equal(res.ok, true, res.error);
  await L.main(() => global.lumio.cmd.newTab());
  assert.ok(await until(async () => (await title()) === 'Custom New Tab'), 'the extension’s page');
  assert.equal(await L.shell(`document.getElementById('address').value`), '', 'the address bar stays empty');
  assert.ok(await until(async () => (await overlayKind()) === 'ntp-override'), 'Lumio asks once');
  assert.match(await overlay(`document.getElementById('card').innerText`), /Change back to Lumio’s new tab page\?[\s\S]*Lumio NTP Test/);
  await shot('ext-05-ntp');
  await overlay(`document.querySelector('[data-ntp=revert]').click(); true`);
  assert.ok(await until(async () => (await title()) === 'New Tab'), 'Lumio’s new tab page is back');
  assert.equal(await L.main((_e, k) => global.lumio.store.settings.disabledExtensions.includes(k), dir), true, 'the extension is off');
  await L.main((_e, k) => global.lumio.extensions.remove(k), dir);
  await L.main(() => global.lumio.cmd.closeTab());
});

test('Report an issue sends only what was ticked', async () => {
  await go(`${base}/report-me`, 'Page report-me');
  await L.main(() => global.lumio.cmd.reportIssue());
  assert.ok(await until(async () => (await overlayKind()) === 'feedback'));
  assert.equal(await until(() => overlay(`document.activeElement.id`)), 'fb-text');
  const fill = (text, { url = false, shot: pic = false } = {}) => overlay(`(() => {
    const t = document.getElementById('fb-text');
    t.value = ${JSON.stringify(text)};
    t.dispatchEvent(new Event('input', { bubbles: true }));
    for (const [id, on] of [['fb-url', ${url}], ['fb-shot', ${pic}]]) { const box = document.getElementById(id); if (box) box.checked = on; }
    document.getElementById('fb-send').click();
    return true;
  })()`);
  await shot('ext-06-report');
  await fill('The page froze.');
  assert.ok(await until(async () => reports.length === 1));
  assert.deepEqual(Object.keys(reports[0]).sort(), ['description', 'system']);
  assert.equal(reports[0].description, 'The page froze.');
  assert.equal(reports[0].system.electron, await L.main(() => process.versions.electron));
  assert.ok(await until(async () => (await overlayKind()) === null), 'it closes after saying thanks');

  await L.main(() => global.lumio.cmd.reportIssue());
  await until(async () => (await overlayKind()) === 'feedback');
  await until(() => overlay(`!!document.getElementById('fb-shot')`));
  await fill('With the page this time.', { url: true, shot: true });
  assert.ok(await until(async () => reports.length === 2));
  assert.equal(reports[1].url, `${base}/report-me`);
  assert.match(reports[1].screenshot, /^data:image\/jpeg;base64,/);
});

test('lumio://version and lumio://flags-lite', async () => {
  await L.main(() => global.lumio.cmd.versionPage());
  assert.ok(await until(async () => (await title()) === 'Version'));
  const info = await until(() => L.page(`document.querySelectorAll('.kv').length === 10 && document.getElementById('info').innerText`));
  const versions = await L.main(() => process.versions);
  assert.match(info, new RegExp(`Electron\\s+${versions.electron.replace(/\./g, '\\.')}`));
  assert.match(info, new RegExp(`Chromium\\s+${versions.chrome.replace(/\./g, '\\.')}`));
  assert.match(info, /Profile path\s+\S+/);
  await shot('ext-07-version');
  await go('chrome://flags', 'Experiments');
  await until(() => L.page(`!!document.querySelector('[data-flag=smoothScrolling]')`));
  // Dark mode for all websites isn't here any more: it's Settings › Appearance (main/force-dark.js).
  assert.equal(await L.page(`!!document.querySelector('[data-flag=forceDark]')`), false, 'no force-dark flag');
  assert.match(await L.page(`document.getElementById('force-dark-note').innerText`), /Settings › Appearance/);
  await L.page(`document.querySelector('[data-flag=smoothScrolling]').click(); true`);
  assert.ok(await until(() => L.main(() => global.lumio.store.settings.flags?.smoothScrolling === false)));
  assert.ok(await until(() => L.page(`!document.getElementById('restart').hidden`)), 'a restart applies it');
  // (Its Restart button is the same page:relaunch as Settings', main/system.js; not pressed here.)
  await L.page(`document.getElementById('reset').click(); true`);
  assert.ok(await until(() => L.main(() => JSON.stringify(global.lumio.store.settings.flags) === '{}')));
});

test('the menu bar: Help, View › Developer, History, and the Mac’s own menus', async () => {
  await go(`${base}/visited-page`, 'Page visited-page');
  const menus = () => L.main(({ Menu }) => Menu.getApplicationMenu().items.map((m) => ({ label: m.label, role: m.role, items: m.submenu?.items.map((i) => i.label) })));
  const top = await menus();
  const help = top.find((m) => m.role === 'help');
  assert.deepEqual(help.items.filter(Boolean), MAC
    ? ['Lumio Browser Help', 'Report an Issue…', 'What’s New', 'Version Info', 'Experiments', 'Terms of Service', 'Privacy Policy', 'Open-Source Licenses']
    : ['Help center', 'Report an issue…', 'What’s new', 'Version Info', 'Experiments', 'Terms of Service', 'Privacy Policy', 'Open-Source Licenses']);
  const win = top.find((m) => m.label === 'Window');
  for (const l of ['Name Window…', 'Task Manager', 'Search Tabs…']) assert.ok(win.items.includes(l), `Window › ${l}`);
  if (MAC) assert.match(String(win.role), /^window$/i, 'the Mac lists its windows there');
  const view = top.find((m) => m.label === 'View');
  assert.ok(view.items.includes('Developer') && view.items.includes('Stop'));
  if (MAC) {
    assert.deepEqual(top.map((m) => m.label), ['Lumio Browser', 'File', 'Edit', 'View', 'History', 'Bookmarks', 'Profiles', 'Tab', 'Window', 'Help']);
    assert.ok(top.find((m) => m.label === 'Edit').items.includes('Speech'));
    // History lists the page a moment after the visit.
    assert.ok(await until(async () => (await menus()).find((m) => m.label === 'History').items.includes('Page visited-page'), 8000));
  }
});

test('DevTools dock where they were last, and the menu changes it', async () => {
  await L.main(() => global.lumio.cmd.setDevtoolsDock('bottom'));
  assert.equal(await L.main(() => global.lumio.store.settings.devtoolsDock), 'bottom');
  await L.main(() => global.lumio.cmd.devtools());
  assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().isDevToolsOpened())));
  await L.main(() => global.lumio.cmd.devtools());
  assert.ok(await until(() => L.main(() => !global.lumio.tabs.wc().isDevToolsOpened())), 'the shortcut toggles them');
  await L.main(() => global.lumio.cmd.setDevtoolsDock('right'));
});

test('Handoff offers the page you are on (Mac)', async () => {
  await go(`${base}/handoff`, 'Page handoff');
  if (!MAC) { assert.equal(await L.main(() => global.lumio.handoff.url), null); return; }
  await L.main(() => global.lumio.current.focus());
  assert.ok(await until(async () => (await L.main(() => global.lumio.handoff.url)) === `${base}/handoff`));
  await go('lumio://settings/', 'Settings');
  assert.ok(await until(async () => (await L.main(() => global.lumio.handoff.url)) === null), 'never Lumio’s own pages');
});
