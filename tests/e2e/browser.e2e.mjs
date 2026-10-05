// End-to-end tests for the browser features: windows, incognito, history,
// downloads, bookmarks, site info, extensions, importing from Chrome, and
// light and dark.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launch, root } from '../../scripts/launch.mjs';

const EXT = path.join(root, 'tests', 'fixtures', 'ext-hello');
const SHOTS = process.env.LUMIO_SHOTS;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-browser-e2e-'));
let L;
let site;
let base;

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
const windows = () => L.main(() => global.lumio.windows.map((w) => ({ id: w.id, incognito: w.incognito, tabs: w.tabs.tabs.map((t) => t.pendingUrl || t.url) })));
// The star's bubble, drawn in the overlay above the page: wait for it, then Done.
const closeBubble = async () => {
  assert.ok(await until(() => L.main(() => global.lumio.current.overlayKind === 'bm-edit')), 'the bubble opened');
  await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector('[data-act=done]').click(); true`));
  assert.ok(await until(() => L.main(() => global.lumio.current.overlayKind === null)), 'Done closed it');
};

// A tiny PDF with one page of text.
function makePdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 18 Tf 20 70 Td (Lumio PDF test) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A fake Chrome profile to import from.
function makeChromeProfile(dir) {
  const profile = path.join(dir, 'Google', 'Chrome', ...(process.platform === 'win32' ? ['User Data'] : []), 'Default');
  fs.mkdirSync(profile, { recursive: true });
  const chromeTime = (ms) => String((ms + 11644473600000) * 1000);
  fs.writeFileSync(path.join(profile, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: { type: 'folder', children: [
        { type: 'url', name: 'Imported One', url: 'https://imported-one.example/', date_added: chromeTime(Date.now() - 86400000) },
        { type: 'folder', name: 'Work', children: [{ type: 'url', name: 'Imported Two', url: 'https://imported-two.example/' }] },
      ] },
      other: { type: 'folder', children: [] },
    },
  }));
  const db = new DatabaseSync(path.join(profile, 'History'));
  db.exec('CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR); CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);');
  db.prepare('INSERT INTO urls(id, url, title) VALUES (?, ?, ?)').run(1, 'https://chrome-history.example/a', 'From Chrome A');
  db.prepare('INSERT INTO urls(id, url, title) VALUES (?, ?, ?)').run(2, 'chrome://settings/', 'Settings');
  db.prepare('INSERT INTO visits(url, visit_time) VALUES (?, ?)').run(1, chromeTime(Date.now() - 3600000));
  db.prepare('INSERT INTO visits(url, visit_time) VALUES (?, ?)').run(1, chromeTime(Date.now() - 7200000));
  db.prepare('INSERT INTO visits(url, visit_time) VALUES (?, ?)').run(2, chromeTime(Date.now() - 7200000));
  db.close();
}

before(async () => {
  const pdf = makePdf();
  site = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/file.bin') {
      r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="lumio-test.bin"', 'content-length': 65536 });
      r.end(Buffer.alloc(65536, 7));
      return;
    }
    if (u.pathname === '/doc.pdf') { r.writeHead(200, { 'content-type': 'application/pdf' }); r.end(pdf); return; }
    if (u.pathname === '/icon.png') { r.writeHead(200, { 'content-type': 'image/png' }); r.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); return; }
    if (u.pathname === '/icon-page') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Icon page</title><link rel="icon" href="/icon.png"><h1>icon</h1>'); return; }
    if (u.pathname === '/cookie') {
      r.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'lumio_test=incognito; Path=/' });
      r.end('<title>Cookie Page</title><script>localStorage.setItem("where", "incognito")</script>');
      return;
    }
    const name = u.pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1><p>Some text about ${name}.</p>`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  const importRoot = path.join(tmp, 'support');
  makeChromeProfile(importRoot);
  L = await launch({ env: { LUMIO_IMPORT_ROOT: importRoot, LUMIO_DOWNLOADS: path.join(tmp, 'downloads') } });
  fs.mkdirSync(path.join(tmp, 'downloads'), { recursive: true });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  await L?.close();
  site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('new windows open, and the session remembers them', async () => {
  await go(`${base}/one`, 'Page one');
  await L.main(() => global.lumio.cmd.newWindow());
  await until(async () => (await windows()).length === 2);
  await go(`${base}/two`, 'Page two');
  await L.wait(600);
  const saved = await L.main(() => global.lumio.store.sessionWindows().map((w) => w.tabs.map((t) => t.url)));
  assert.equal(saved.length, 2);
  assert.ok(saved.flat().some((u) => u.endsWith('/one')) && saved.flat().some((u) => u.endsWith('/two')));
  // Closing a window adds it to Recently Closed; reopening brings it back.
  await L.main(() => global.lumio.cmd.closeWindow());
  await until(async () => (await windows()).length === 1);
  const closed = await L.main(() => global.lumio.recentlyClosed.map((e) => e.kind));
  assert.equal(closed.at(-1), 'window');
  await L.main(() => global.lumio.cmd.reopenTab());
  await until(async () => (await windows()).length === 2);
  assert.ok((await windows()).some((w) => w.tabs.some((u) => u.endsWith('/two'))));
  await L.main(() => global.lumio.cmd.closeWindow());
  await until(async () => (await windows()).length === 1);
});

test('pinned tabs stay first and are saved as pinned', async () => {
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/pin-me`);
  await until(async () => (await title()).includes('pin-me'));
  await L.main(() => global.lumio.cmd.pinTab());
  const state = await L.main(() => global.lumio.tabs.state().tabs.map((t) => ({ url: t.url, pinned: t.pinned })));
  assert.equal(state[0].pinned, true);
  assert.ok(state[0].url.endsWith('/pin-me'));
  // A pinned tab can't be dragged after unpinned ones.
  await L.main(() => { const t = global.lumio.tabs; t.move(t.tabs[0].id, 5); });
  assert.equal(await L.main(() => global.lumio.tabs.tabs[0].pinned), true);
  assert.equal(await L.shell(`document.querySelector('.tab.pinned') !== null`), true);
  await L.wait(500);
  const saved = await L.main(() => global.lumio.store.sessionWindows()[0].tabs);
  assert.equal(saved[0].pinned, true);
  await shot('10-pinned');
  await L.main(() => global.lumio.cmd.pinTab());
});

test('moving a tab to a new window keeps the page as it was', async () => {
  await L.page('window.__marker = 42; true');
  const before = await L.main(() => global.lumio.tabs.tabs.length);
  await L.main(() => global.lumio.cmd.moveTabToNewWindow());
  await until(async () => (await windows()).length === 2);
  const ws = await windows();
  assert.equal(ws[0].tabs.length, before - 1);
  assert.equal(ws[1].tabs.length, 1);
  assert.equal(await L.page('window.__marker'), 42, 'same page, not reloaded');
  await L.main(() => global.lumio.cmd.closeWindow());
  await until(async () => (await windows()).length === 1);
});

test('incognito windows keep no history or cookies', async () => {
  const historyBefore = await L.main(() => global.lumio.store.history().length);
  await L.main((_e, u) => global.lumio.createWindow({ incognito: true, urls: [u] }), `${base}/cookie`);
  await until(async () => (await windows()).some((w) => w.incognito));
  assert.equal(await L.main(() => global.lumio.current.incognito), true);
  await until(async () => (await title()).includes('Cookie Page'));
  await go(`${base}/secret-incognito-page`, 'secret-incognito-page');
  assert.equal(await L.shell(`document.body.classList.contains('incognito') && !document.getElementById('incognito-badge').hidden`), true);
  assert.equal(await L.shell(`document.getElementById('ext-area').hidden`), true, 'no extensions in incognito');
  await shot('11-incognito');

  const history = await L.main(() => global.lumio.store.history().map((h) => h.url));
  assert.equal(history.length, historyBefore);
  assert.ok(!history.some((u) => u.includes('secret-incognito')));
  const incogCookies = await L.main(() => global.lumio.profiles.incognito.session.cookies.get({ name: 'lumio_test' }));
  assert.equal(incogCookies.length, 1);
  const normalCookies = await L.main(() => global.lumio.profiles.normal.session.cookies.get({ name: 'lumio_test' }));
  assert.equal(normalCookies.length, 0);
  // Closing incognito tabs doesn't touch the app-wide Recently Closed list.
  const closedBefore = await L.main(() => global.lumio.recentlyClosed.length);
  await L.main(() => global.lumio.cmd.newTab());
  await L.main(() => global.lumio.cmd.closeTab());
  assert.equal(await L.main(() => global.lumio.recentlyClosed.length), closedBefore);

  // Close the last incognito window: the next one starts empty.
  await L.main(() => global.lumio.cmd.closeWindow());
  assert.ok(await until(async () => (await L.main(() => global.lumio.profiles.incognito === null))), 'incognito profile thrown away');
  await L.main((_e, u) => global.lumio.createWindow({ incognito: true, urls: [u] }), `${base}/fresh`);
  await until(async () => (await title()).includes('fresh'));
  assert.equal(await L.page('document.cookie'), '');
  assert.equal(await L.page('localStorage.getItem("where")'), null);
  await L.main(() => global.lumio.cmd.closeWindow());
  await until(async () => (await windows()).length === 1);
});

test('history page: search, delete selected, clear a time range', async () => {
  await go(`${base}/alpha-page`, 'alpha-page');
  await go(`${base}/beta-page`, 'beta-page');
  // An old visit from 10 days ago.
  await L.main((_e, u) => global.lumio.store.importHistory([{ url: u, title: 'Old visit', time: Date.now() - 10 * 86400000 }]), `${base}/old-page`);
  await go('lumio://history/', 'History');
  await until(() => L.page(`document.querySelectorAll('.item').length > 2`));
  await L.page(`(() => { const s = document.getElementById('search'); s.value = 'beta'; s.dispatchEvent(new Event('input')); return true })()`);
  await until(() => L.page(`document.querySelectorAll('.item').length === 1`));
  assert.match(await L.page(`document.querySelector('.item a.title').innerHTML`), /<mark>beta<\/mark>/);
  await shot('12-history-search');
  // Select it and delete.
  await L.page(`document.querySelector('.item input[type=checkbox]').click(); true`);
  assert.equal(await L.page(`document.getElementById('selcount').textContent`), '1 selected');
  await L.page(`document.getElementById('sel-delete').click(); true`);
  await until(async () => !(await L.main(() => global.lumio.store.history().some((h) => h.url.endsWith('/beta-page')))));
  // Clear the last 24 hours of history: the old visit survives.
  await L.page(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); return true })()`);
  await L.page(`(() => {
    const d = document.getElementById('clear-dialog');
    d.showModal();
    document.getElementById('range').value = '86400000';
    d.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = c.value === 'history'; });
    d.close('clear');
    return true;
  })()`);
  await until(async () => (await L.main(() => global.lumio.store.history().length)) === 1);
  const left = await L.main(() => global.lumio.store.history().map((h) => h.url));
  assert.ok(left[0].endsWith('/old-page'));
  // Filter by site.
  await until(() => L.page(`document.querySelectorAll('.item').length === 1`));
  await L.page(`document.querySelector('.item button.host').click(); true`);
  assert.match(await L.page(`document.querySelector('#filter span').textContent`), /127\.0\.0\.1/);
});

test('recently closed tabs show on the history page and reopen', async () => {
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/closed-one`);
  await until(async () => (await title()).includes('closed-one'));
  await L.main(() => global.lumio.cmd.closeTab());
  await L.main((_e, u) => { const w = global.lumio.current; const t = w.tabs.tabs.find((x) => (x.url || '').startsWith('lumio://history')); w.tabs.activate(t.id); }, null);
  await L.page(`document.querySelector('[data-view=closed]').click(); true`);
  await until(() => L.page(`document.querySelectorAll('.closed-item').length > 0`));
  assert.match(await L.page(`document.querySelector('.closed-item').innerText`), /closed-one/);
  await shot('13-recently-closed');
  await L.page(`document.querySelector('.closed-item [data-reopen]').click(); true`);
  assert.ok(await until(async () => (await title()).includes('closed-one')), 'reopened tab loaded');
  assert.ok(await until(async () => !(await L.main(() => global.lumio.tabs.wc().isLoading()))), 'and finished loading');
});

test('downloads finish, show on the downloads page and are remembered', async () => {
  await go(`${base}/page-for-download`, 'page-for-download');
  await L.main((_e, u) => global.lumio.tabs.wc().downloadURL(u), `${base}/file.bin`);
  await until(async () => (await L.main(() => global.lumio.store.downloads().some((d) => d.state === 'completed'))));
  const d = await L.main(() => global.lumio.store.downloads()[0]);
  assert.equal(d.name, 'lumio-test.bin');
  assert.equal(fs.statSync(d.path).size, 65536);
  assert.ok(d.path.startsWith(path.join(tmp, 'downloads')));
  await go('lumio://downloads/', 'Downloads');
  await until(() => L.page(`document.querySelectorAll('.dl').length === 1`));
  assert.match(await L.page(`document.querySelector('.dl').innerText`), /lumio-test\.bin[\s\S]*66 KB/);
  await shot('14-downloads');
  // Removing it from the list keeps the file.
  await L.page(`document.querySelector('.dl [data-act=remove]').click(); true`);
  await until(async () => (await L.main(() => global.lumio.store.downloads().length)) === 0);
  assert.ok(fs.existsSync(d.path));
});

test('bookmarks bar, manager edits and reorder', async () => {
  await go(`${base}/mark-a`, 'mark-a');
  await L.main(() => global.lumio.cmd.bookmark());
  await closeBubble();
  await go(`${base}/mark-b`, 'mark-b');
  await L.main(() => global.lumio.cmd.bookmark());
  await closeBubble();
  // The bar is on by default, right under the address bar.
  await until(() => L.shell(`!document.getElementById('bookmarks-bar').hidden && document.querySelectorAll('.bm-items .bm-item').length === 2`));
  assert.match(await L.shell(`document.querySelector('.bm-items .bm-item').textContent`), /mark-a/);
  await shot('15-bookmarks-bar');
  // Clicking a bookmark opens it in the current tab.
  await L.shell(`document.querySelector('.bm-items .bm-item').click(); true`);
  await until(async () => (await title()).includes('mark-a'));
  // Edit the title in the manager.
  await go(`lumio://bookmarks/?edit=${encodeURIComponent(base + '/mark-b')}`, 'Bookmarks');
  await until(() => L.page(`!!document.getElementById('edit-title')`));
  await L.page(`(() => { document.getElementById('edit-title').value = 'Renamed B'; document.querySelector('[data-act=save]').click(); return true })()`);
  await until(async () => (await L.main(() => global.lumio.store.bookmarks().some((b) => b.title === 'Renamed B'))));
  await until(() => L.shell(`[...document.querySelectorAll('.bm-item')].some((b) => b.textContent.includes('Renamed B'))`));
  // Reorder: B first.
  await L.main((_e, u) => { const m = global.lumio.store.marks; m.move([m.byUrl(u)[0].id], 'bar', 0); global.lumio.bookmarks.changed(); }, `${base}/mark-b`);
  assert.equal(await L.main(() => global.lumio.store.bookmarks()[0].title), 'Renamed B');
  assert.ok(await until(() => L.shell(`document.querySelector('.bm-items .bm-item').textContent.includes('Renamed B')`)));
  // An imported bookmark comes without an icon; opening the page gives it one.
  await L.main((_e, u) => global.lumio.store.importBookmarks([{ url: u, title: 'Icon page' }]), `${base}/icon-page`);
  await go(`${base}/icon-page`, 'Icon page');
  await until(() => L.shell(`[...document.querySelectorAll('.bm-item img')].some((i) => i.src === '${base}/icon.png')`));
  assert.equal(await L.main((_e, u) => global.lumio.store.bookmarks().find((b) => b.url === u).favicon, `${base}/icon-page`), `${base}/icon.png`);
  await shot('15b-bookmarks-bar-icons');
  // Turned off, it hides on web pages but still shows on the new tab page, like Chrome.
  await L.main(() => global.lumio.cmd.toggleBookmarksBar());
  await until(() => L.shell(`document.getElementById('bookmarks-bar').hidden`));
  await L.main(() => global.lumio.cmd.newTab());
  await until(() => L.shell(`!document.getElementById('bookmarks-bar').hidden`));
  await L.main(() => global.lumio.cmd.closeTab());
  await until(() => L.shell(`document.getElementById('bookmarks-bar').hidden`));
  await L.main(() => global.lumio.cmd.toggleBookmarksBar());
});

test('site info shows permissions and changes them', async () => {
  await go(`${base}/site-info`, 'site-info');
  const info = await L.shell(`window.lumio.invoke('site:info')`);
  assert.equal(info.host, `127.0.0.1:${site.address().port}`);
  assert.equal(info.secure, false);
  assert.ok(info.permissions.some((p) => p.permission === 'geolocation'));
  // In real use, clicking the page moves focus out of the address bar.
  await L.shell(`document.getElementById('address').blur(); document.getElementById('site-icon').click(); true`);
  await until(() => L.main(() => global.lumio.win.contentView.children.includes(global.lumio.current.overlay)));
  await L.wait(300);
  await shot('16-site-info');
  await L.shell(`window.lumio.send('site:set-permission', { permission: 'geolocation', value: 'block' }); true`);
  await until(async () => (await L.main((_e, o) => global.lumio.store.settings.sitePermissions[o]?.geolocation === false, base)));
  await L.shell(`window.lumio.send('site:set-permission', { permission: 'geolocation', value: 'ask' }); true`);
  await until(async () => (await L.main((_e, o) => global.lumio.store.settings.sitePermissions[o] === undefined, base)));
  await L.shell(`window.lumio.send('overlay:hide'); true`);
});

test('extensions: content scripts, toolbar popup, chrome.tabs, turn off and remove', async () => {
  const res = await L.main((_e, p) => global.lumio.extensions.loadUnpacked(p), EXT);
  assert.equal(res.ok, true, res.error);
  await go(`${base}/with-extension`, 'with-extension');
  assert.ok(await until(() => L.page(`document.documentElement.dataset.lumioExt === 'content-script-ran'`)), 'content script ran');
  assert.ok(await until(async () => Number(await L.page(`document.documentElement.dataset.lumioExtTabs`)) >= 1), 'background worker answered chrome.tabs.query');
  // Toolbar button with the extension's icon.
  assert.ok(await until(() => L.shell(`document.getElementById('ext-actions').shadowRoot?.querySelectorAll('.action').length === 1`)));
  // Its popup opens under the button and can open tabs.
  await L.shell(`document.getElementById('ext-actions').shadowRoot.querySelector('.action').click(); true`);
  const popup = () => L.main(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popup.html'));
    return w ? { visible: w.isVisible(), bounds: w.getBounds() } : null;
  });
  assert.ok(await until(async () => (await popup())?.visible), 'popup visible');
  const pb = (await popup()).bounds;
  const wb = await L.main(() => global.lumio.win.getBounds());
  assert.ok(pb.width > 200 && pb.height > 60, `popup sized to its content (${pb.width}x${pb.height})`);
  assert.ok(pb.y > wb.y + 60 && pb.y < wb.y + 140, 'popup sits under the toolbar');
  const popupText = await until(() => L.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popup.html')).webContents.executeJavaScript(`document.getElementById('title').textContent.includes('with-extension') && document.getElementById('title').textContent`)));
  assert.match(popupText, /Active tab: Page with-extension/);
  const tabsBefore = await L.main(() => global.lumio.tabs.tabs.length);
  await L.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popup.html')).webContents.executeJavaScript(`document.getElementById('open').click()`));
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === tabsBefore + 1), 'chrome.tabs.create opened a tab');
  await L.main(() => global.lumio.cmd.closeTab());

  // The extensions page lists it; turning it off unloads it.
  await go('lumio://extensions/', 'Extensions');
  await until(() => L.page(`document.querySelectorAll('.ext').length === 1`));
  assert.match(await L.page(`document.querySelector('.ext .name').textContent`), /Lumio Test Extension/);
  assert.equal(await L.page(`document.querySelector('.ext .icon img').src.startsWith('data:image/png')`), true);
  await shot('17-extensions');
  await L.page(`(() => { const t = document.querySelector('.ext input[data-act=toggle]'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
  await until(async () => (await L.main(() => global.lumio.extensions.api.getAllExtensions().length)) === 0);
  await until(() => L.page(`document.querySelector('.ext').classList.contains('off')`));
  await go(`${base}/without-extension`, 'without-extension');
  assert.equal(await L.page(`document.documentElement.dataset.lumioExt || 'none'`), 'none');
  assert.ok(await until(() => L.shell(`document.getElementById('ext-actions').shadowRoot?.querySelectorAll('.action').length === 0`)));
  // On again, then remove.
  const key = await L.main(() => global.lumio.extensions.list()[0].key);
  await L.main((_e, k) => global.lumio.extensions.setEnabled(k, true), key);
  assert.equal(await L.main(() => global.lumio.extensions.api.getAllExtensions().length), 1);
  await L.main((_e, k) => global.lumio.extensions.remove(k), key);
  assert.equal(await L.main(() => global.lumio.extensions.list().length), 0);
  assert.equal(await L.main(() => global.lumio.extensions.api.getAllExtensions().length), 0);
});

test('Chrome Web Store installs only accept the real store page', async () => {
  const deny = await L.main(() => global.lumio.extensions.confirmInstall({ frame: { origin: 'https://chromewebstore.google.com.evil.example' }, manifest: {}, localizedName: 'x' }));
  assert.equal(deny.action, 'deny');
  const registered = await L.main(() => global.lumio.profiles.normal.session.getPreloadScripts().map((p) => p.id));
  assert.ok(registered.includes('electron-chrome-web-store'));
  assert.ok(registered.includes('crx-mv3-preload'));
});

test('imports bookmarks and history from Chrome', async () => {
  await go('lumio://settings/#import', 'Settings');
  await until(() => L.page(`document.getElementById('import-from').value === 'chrome'`));
  await L.page(`document.getElementById('import-go').click(); true`);
  const msg = await until(() => L.page(`/Imported/.test(document.getElementById('import-desc').textContent) && document.getElementById('import-desc').textContent`));
  assert.match(msg, /Imported 2 bookmarks, 2 history entries from Google Chrome/);
  const marks = await L.main(() => global.lumio.store.bookmarks().map((b) => b.title));
  assert.ok(marks.includes('Imported One') && marks.includes('Imported Two'));
  // Chrome's folders come along.
  const work = await L.main(() => { const m = global.lumio.store.marks; const f = m.folders().find((x) => x.title === 'Work'); return f ? m.folder(f.id).children.map((n) => n.title) : null; });
  assert.deepEqual(work, ['Imported Two']);
  const hist = await L.main(() => global.lumio.store.history().filter((h) => h.url.includes('chrome-history.example')).length);
  assert.equal(hist, 2);
  // Importing again doesn't duplicate anything.
  await L.page(`document.getElementById('import-go').click(); true`);
  assert.ok(await until(() => L.page(`/Nothing new to import/.test(document.getElementById('import-desc').textContent)`)));
});

test('PDFs open in the built-in viewer instead of downloading', async () => {
  const downloadsBefore = await L.main(() => global.lumio.store.downloads().length);
  await go(`${base}/doc.pdf`);
  await L.wait(2500);
  assert.match(await L.main(() => global.lumio.tabs.wc().getURL()), /doc\.pdf$/);
  assert.equal(await L.main(() => global.lumio.store.downloads().length), downloadsBefore);
  await shot('18-pdf');
});

test('chrome:// addresses open Lumio pages', async () => {
  await L.main(() => global.lumio.tabs.navigate('chrome://extensions'));
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())) === 'lumio://extensions/');
  await L.main(() => global.lumio.tabs.navigate('chrome://history'));
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())) === 'lumio://history/');
});

test('Settings › Theme: Light makes the window and Lumio’s pages light, incognito stays dark, System goes back', async () => {
  const winBg = () => L.main(() => global.lumio.win.getBackgroundColor().toLowerCase());
  const tabBg = () => L.main(() => global.lumio.tabs.active.view.lastBackground);
  const choose = (value) => L.page(`document.querySelector('input[name=appearance][value=${value}]').click(); true`);
  const checked = () => L.page(`document.querySelector('input[name=appearance]:checked')?.value`);
  const shellLooks = () => L.shell(`[document.documentElement.dataset.appearance ?? null, matchMedia('(prefers-color-scheme: light)').matches, getComputedStyle(document.body).backgroundColor]`);
  await go('lumio://settings/#appearance', 'Settings');
  assert.ok(await until(async () => (await checked()) === 'system'));
  // Tests run dark under System (main/theme.js), whatever this computer uses.
  assert.equal(await L.main((e) => e.nativeTheme.shouldUseDarkColors), true);
  assert.equal(await winBg(), '#070708');
  // Records what the settings tab is given behind its page (views can't be asked).
  await L.main(() => {
    const v = global.lumio.tabs.active.view;
    const set = v.setBackgroundColor.bind(v);
    v.setBackgroundColor = (c) => { v.lastBackground = c; set(c); };
    return true;
  });
  try {
    await choose('light');
    assert.ok(await until(async () => (await L.main(() => global.lumio.store.settings.appearance)) === 'light'));
    assert.deepEqual(await L.main((e) => [e.nativeTheme.themeSource, e.nativeTheme.shouldUseDarkColors]), ['light', false]);
    assert.ok(await until(async () => (await winBg()) === '#f3f3f5'), 'window background');
    assert.ok(await until(async () => (await tabBg()) === '#f3f3f5'), 'tab background');
    // The window's UI follows the system scheme (only incognito forces one).
    assert.ok(await until(async () => JSON.stringify(await shellLooks()) === JSON.stringify([null, true, 'rgb(243, 243, 245)'])), `shell: ${JSON.stringify(await shellLooks())}`);
    assert.ok(await until(async () => (await L.page(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(243, 243, 245)'), 'settings page');
    await shot('18b-light');

    // An incognito window opened now is dark anyway.
    await L.main(() => { global.lumio.createWindow({ incognito: true }); return true; });
    assert.ok(await until(() => L.main(() => global.lumio.current.incognito && global.lumio.tabs.active?.url === 'lumio://newtab/')));
    assert.equal(await winBg(), '#0d0b12');
    assert.ok(await until(async () => (await L.shell(`document.documentElement.dataset.appearance`)) === 'dark'), 'its UI is served dark');
    assert.ok(await until(async () => (await L.shell(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(13, 11, 18)'), 'incognito background');
    assert.ok(await until(async () => (await L.page(`document.documentElement.dataset.appearance`)) === 'dark'), 'its new tab page is served dark');
    assert.equal(await L.page(`getComputedStyle(document.body).color`), 'rgb(237, 237, 238)');
    await shot('18c-light-incognito');
    await L.main(() => global.lumio.cmd.closeWindow());
    assert.ok(await until(async () => (await windows()).every((w) => !w.incognito)));

    // The View menu changes it too, and the open Settings page follows.
    await L.main(() => global.lumio.cmd.setAppearance('dark'));
    assert.ok(await until(async () => (await checked()) === 'dark'));
    await choose('system');
    assert.ok(await until(async () => (await L.main(() => global.lumio.store.settings.appearance)) === 'system'));
    assert.equal(await L.main((e) => e.nativeTheme.themeSource), 'dark');
    assert.ok(await until(async () => (await winBg()) === '#070708'), 'window background');
    assert.ok(await until(async () => (await tabBg()) === '#0c0c0d'), 'tab background');
    assert.ok(await until(async () => JSON.stringify(await shellLooks()) === JSON.stringify([null, false, 'rgb(7, 7, 8)'])), `shell: ${JSON.stringify(await shellLooks())}`);
  } finally {
    // Leave the app as the tests expect it: System (dark), no incognito window.
    await L.main(() => {
      global.lumio.store.setSetting('appearance', 'system');
      for (const w of global.lumio.windows) if (w.incognito) w.close();
      return true;
    });
  }
});
