// End-to-end tests for everyday navigation (main/navigation.js): the link
// status bubble, Back/Forward history menus and new-tab clicks, the mouse's
// back button and swipes, Chrome's shortcuts, Home and start pages, per-site
// zoom (in a session and after a restart), the find bar per tab, Open File
// and Save Page As formats.
// Run: npm run test:e2e   (GitHub CI; set LUMIO_SHOTS=/some/dir for screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const MAC = process.platform === 'darwin';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-nav-e2e-'));
let L;
let site;
let base;

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000, app = L) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await app.wait(150);
  }
};
const title = (app = L) => app.main(() => global.lumio.tabs.wc().getTitle());
const go = async (url, expectTitle, app = L) => {
  await app.main((_e, u) => global.lumio.tabs.navigate(u), url);
  if (expectTitle) assert.ok(await until(async () => (await title(app)).includes(expectTitle), 10_000, app), `page "${expectTitle}" loaded`);
};
const pageIndex = () => L.main(() => global.lumio.tabs.wc().navigationHistory.getActiveIndex());

before(async () => {
  site = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/links') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(`<title>Links</title><body style="margin:0;height:2000px">
        <a id="far" href="/target-page?from=links" style="position:absolute;left:300px;top:200px;font-size:24px">A link far from the corner</a>
        <a id="corner" href="/corner-page" style="position:fixed;left:2px;bottom:2px;font-size:14px">Corner link</a>
        <a id="file" href="/file.bin" style="position:absolute;left:300px;top:400px;font-size:24px">Download me</a></body>`);
      return;
    }
    if (u.pathname === '/slow') { setTimeout(() => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Slow</title>slow'); }, 8000); return; }
    if (u.pathname === '/file.bin') {
      r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="alt-click.bin"', 'content-length': 2048 });
      r.end(Buffer.alloc(2048, 3));
      return;
    }
    const name = u.pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1><p>Some words about ${name}, and a needle.</p><img src="/pixel.png">`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  fs.mkdirSync(path.join(tmp, 'downloads'), { recursive: true });
  L = await launch({ env: { LUMIO_DOWNLOADS: path.join(tmp, 'downloads') } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  await L?.close();
  site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Moves the pointer to a point in the page (page coordinates).
const pointAt = (x, y) => L.main((_e, p) => { global.lumio.tabs.wc().sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); return true; }, { x, y });
const center = (id) => L.page(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
const bubble = () => L.main(() => {
  const w = global.lumio.current;
  const v = w.hud?.views.status;
  if (!v || !v.getVisible()) return null;
  return { bounds: v.getBounds(), page: w.tabs.active.view.getBounds(), side: w.hud.side };
});
const bubbleText = () => L.main(() => global.lumio.current.hud.views.status.webContents.executeJavaScript(`document.querySelector('#bubble .t').textContent`));

test('hovering a link shows its address at the bottom-left of the page, away from the pointer', async () => {
  await go(`${base}/links`, 'Links');
  const far = await center('far');
  await pointAt(far.x, far.y);
  const shown = await until(async () => { const b = await bubble(); return b && b.bounds.width > 20 && b; });
  assert.ok(shown, 'the bubble shows');
  assert.equal(shown.bounds.x, shown.page.x, 'at the left edge of the page');
  assert.equal(shown.bounds.y + shown.bounds.height, shown.page.y + shown.page.height, 'at the bottom');
  assert.ok(await until(async () => (await bubbleText()).includes('/target-page?from=links')));
  await shot('nav-01-status-bubble');
  // The pointer on a link in that corner: the bubble moves to the other side.
  const corner = await center('corner');
  await pointAt(corner.x, corner.y);
  assert.ok(await until(async () => (await bubbleText()).includes('/corner-page')));
  const moved = await until(async () => { const b = await bubble(); return b && b.side === 'right' && b; });
  assert.ok(moved, 'moved to the right');
  assert.equal(moved.bounds.x + moved.bounds.width, moved.page.x + moved.page.width);
  // Off the links: it fades away.
  await pointAt(150, 500);
  assert.ok(await until(async () => !(await bubble())), 'hidden');
  // Another tab: gone at once.
  await pointAt(far.x, far.y);
  await until(() => bubble());
  await L.main(() => global.lumio.cmd.newTab());
  assert.ok(await until(async () => !(await bubble()), 2000));
  await L.main(() => global.lumio.cmd.closeTab());
});

test('Back and Forward menus list this tab’s pages; middle-click opens one in a new tab with its history', async () => {
  await go(`${base}/h1`, 'Page h1');
  await go(`${base}/h2`, 'Page h2');
  await go(`${base}/h3`, 'Page h3');
  const labels = (dir) => L.main((_e, d) => (global.lumio.nav.historyTemplate(global.lumio.current, d) || []).map((i) => i.label || i.type), dir);
  const back = await labels('back');
  assert.deepEqual(back.slice(0, 3), ['Page h2', 'Page h1', 'Links']);
  assert.deepEqual(back.slice(-2), ['separator', 'Show Full History']);
  assert.deepEqual(await labels('forward'), []);
  // Picking "Page h1" goes there.
  await L.main(() => { global.lumio.nav.historyTemplate(global.lumio.current, 'back')[1].click(null, null, {}); return true; });
  assert.ok(await until(async () => (await title()) === 'Page h1'));
  assert.deepEqual((await labels('forward')).slice(0, 2), ['Page h2', 'Page h3']);
  // Middle-click on Forward: Page h2 in a background tab, which can go back to h1.
  const before = await L.main(() => global.lumio.tabs.tabs.length);
  assert.ok(await until(() => L.shell(`!document.getElementById('forward').disabled`)));
  await L.shell(`document.getElementById('forward').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })); true`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === before + 1));
  const copy = await until(() => L.main(() => {
    const m = global.lumio.tabs;
    const t = m.tabs[m.tabs.indexOf(m.active) + 1];
    const wc = t?.view?.webContents;
    return wc && !wc.isLoading() && wc.getTitle() === 'Page h2' && { back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward(), active: m.activeId === t.id };
  }));
  assert.deepEqual(copy, { back: true, forward: true, active: false });
  assert.equal(await title(), 'Page h1', 'this tab stayed where it was');
  await L.main(() => { const m = global.lumio.tabs; m.close(m.tabs[m.tabs.indexOf(m.active) + 1].id); return true; });
});

test('the mouse’s back button and (on a Mac) a two-finger swipe go back once', async () => {
  await go(`${base}/m1`, 'Page m1');
  await go(`${base}/m2`, 'Page m2');
  // What the page's preload sends for the mouse's back button.
  const mouse = (msg) => L.main(({ ipcMain }, m) => { const wc = global.lumio.tabs.wc(); ipcMain.emit('nav:mouse', { sender: wc, senderFrame: wc.mainFrame }, m); return true; }, msg);
  const start = await pageIndex();
  await mouse({ phase: 'down' });
  await mouse({ phase: 'up', dir: 'back' });
  assert.ok(await until(async () => (await title()) === 'Page m1'));
  await L.wait(400);
  assert.equal(await pageIndex(), start - 1, 'once');
  if (MAC) {
    const swipe = (msg) => L.main(({ ipcMain }, m) => { const wc = global.lumio.tabs.wc(); ipcMain.emit('nav:swipe', { sender: wc, senderFrame: wc.mainFrame }, m); return true; }, msg);
    await swipe({ dx: 120 });
    assert.ok(await until(() => L.main(() => global.lumio.current.hud.views.swipe?.getVisible())), 'the arrow shows');
    await shot('nav-02-swipe-arrow');
    await swipe({ dx: 400, end: true });
    assert.ok(await until(async () => (await title()) === 'Page m2'), 'swiped forward');
    assert.ok(await until(async () => !(await L.main(() => global.lumio.current.hud.views.swipe.getVisible()))), 'the arrow goes away');
  }
});

test('shortcuts: Chrome’s keys are in the menu, and view source, stop, Esc, Alt-click and Delete Browsing Data work', async () => {
  const keys = await L.main(({ Menu }) => {
    const out = {};
    const walk = (items) => items.forEach((i) => { if (i.accelerator) out[i.label] = i.accelerator; if (i.submenu) walk(i.submenu.items); });
    walk(Menu.getApplicationMenu().items);
    return out;
  });
  assert.equal(keys['Open File…'], 'CmdOrCtrl+O');
  assert.equal(keys['View Source'], MAC ? 'Cmd+Alt+U' : 'Ctrl+U'); // View › Developer (main/menu-extras.js)
  assert.equal(keys['JavaScript Console'], MAC ? 'Cmd+Alt+J' : 'Ctrl+Shift+J');
  assert.equal(keys.Downloads, MAC ? 'Cmd+Alt+L' : 'Ctrl+J');
  assert.equal(keys['Bookmark All Tabs…'], 'CmdOrCtrl+Shift+D');
  assert.equal(keys['Ask Lumio'], MAC ? 'Cmd+J' : 'Ctrl+Shift+K');
  assert.equal(keys[MAC ? 'Report an Issue…' : 'Report an issue…'], 'Alt+Shift+I');
  if (!MAC) assert.equal(keys['Help center'], 'F1');
  assert.equal(keys.Home, MAC ? 'Cmd+Shift+H' : 'Alt+Home');
  if (MAC) assert.equal(keys.Stop, 'Cmd+.');

  // View source opens next to the page.
  await go(`${base}/source-me`, 'Page source-me');
  await L.main(() => global.lumio.cmd.viewSource());
  assert.ok(await until(() => L.main(() => global.lumio.tabs.active.url.startsWith('view-source:') && global.lumio.tabs.active.url)));
  await L.main(() => global.lumio.cmd.closeTab());

  // Stop (⌘. / the menu) and Esc in the page stop a page that's loading.
  for (const how of ['menu', 'esc']) {
    await L.main((_e, u) => { global.lumio.tabs.navigate(u); return true; }, `${base}/slow`);
    assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().isLoading())));
    if (how === 'menu') await L.main(() => global.lumio.cmd.stop());
    else await L.main(() => { const wc = global.lumio.tabs.wc(); wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); return true; });
    assert.ok(await until(async () => !(await L.main(() => global.lumio.tabs.wc().isLoading())), 3000), `${how} stopped it`);
  }

  // Alt/Option-click on a link downloads it instead of opening it.
  await go(`${base}/links`, 'Links');
  const link = await center('file');
  const before = await L.main(() => global.lumio.store.downloads().length);
  await L.main((_e, p) => {
    const wc = global.lumio.tabs.wc();
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
    return true;
  }, link);
  assert.ok(await until(() => L.main(() => global.lumio.store.downloads().some((d) => d.name === 'alt-click.bin' && d.state === 'completed'))), 'downloaded');
  assert.ok((await L.main(() => global.lumio.store.downloads().length)) > before);
  assert.equal(await title(), 'Links', 'and stayed on the page');

  // ⌘⇧⌫ / Ctrl+Shift+Delete: Delete browsing data (batch 6's page, lumio://settings/clearBrowserData).
  await L.main(() => global.lumio.cmd.clearBrowsingData());
  assert.ok(await until(() => L.page(`location.href === 'lumio://settings/clearBrowserData' && !!document.getElementById('cd-list') && !!document.getElementById('go')`)));
  await shot('nav-03-clear-data');
  await L.main(() => global.lumio.cmd.closeTab());
});

test('the JavaScript console opens Developer Tools', async () => {
  await go(`${base}/console-page`, 'Page console-page');
  await L.main(() => global.lumio.cmd.console());
  assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().isDevToolsOpened())));
  await L.main(() => { global.lumio.tabs.wc().closeDevTools(); return true; });
});

test('Home: off by default; on, it opens the chosen page', async () => {
  assert.equal(await L.shell(`document.getElementById('home').hidden`), true);
  await L.main((_e, u) => { global.lumio.nav.setPref('homePage', u); global.lumio.nav.setPref('showHome', true); return true; }, `${base}/my-home`);
  assert.ok(await until(() => L.shell(`!document.getElementById('home').hidden`)), 'shown next to Reload');
  await go(`${base}/elsewhere`, 'Page elsewhere');
  await L.shell(`document.getElementById('home').click(); true`);
  assert.ok(await until(async () => (await title()) === 'Page my-home'));
  await L.main(() => { global.lumio.cmd.home(); return true; });
  await shot('nav-04-home');
  await L.main(() => { global.lumio.nav.setPref('showHome', false); global.lumio.nav.setPref('homePage', 'newtab'); return true; });
  assert.ok(await until(() => L.shell(`document.getElementById('home').hidden`)));
});

test('zoom is shared by a site’s tabs, shows its bubble, and the default applies everywhere else', async () => {
  await go(`${base}/zoom-a`, 'Page zoom-a');
  await L.main(() => global.lumio.cmd.zoom(1));
  const factor = () => L.main(() => Math.round(global.lumio.tabs.wc().getZoomFactor() * 100));
  assert.equal(await factor(), 110);
  assert.ok(await until(() => L.shell(`!document.getElementById('zoom-badge').hidden && document.getElementById('zoom-badge').textContent === '110%'`)));
  assert.ok(await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'zoom')), 'the zoom bubble shows');
  await shot('nav-05-zoom-bubble');
  assert.deepEqual(await L.main(() => global.lumio.store.settings.zoomLevels), { '127.0.0.1': 110 });
  // Another tab on the same site has the same zoom (Chromium shares it by host).
  await L.main((_e, u) => { global.lumio.tabs.create(u); return true; }, `${base}/zoom-b`);
  assert.ok(await until(async () => (await title()) === 'Page zoom-b'));
  assert.equal(await factor(), 110);
  // A different site gets the default; a new default reaches it at once.
  await go('lumio://newtab/');
  assert.ok(await until(async () => (await factor()) === 100));
  await L.main(() => global.lumio.nav.setPref('defaultZoom', 125));
  assert.ok(await until(async () => (await factor()) === 125));
  assert.ok(await until(() => L.shell(`document.getElementById('zoom-badge').hidden`)), 'the default shows no badge');
  await L.main(() => global.lumio.nav.setPref('defaultZoom', 100));
  // Reset: the site goes back to the default and leaves the list.
  await L.main(() => global.lumio.cmd.closeTab());
  await L.main(() => global.lumio.cmd.zoom(0));
  assert.deepEqual(await L.main(() => global.lumio.store.settings.zoomLevels), {});
  await L.main(() => global.lumio.current.hideOverlay());
});

test('each tab keeps its own find bar, and ⌘E uses the selection', async () => {
  await go(`${base}/find-one`, 'Page find-one');
  await L.main(() => global.lumio.cmd.find());
  await L.shell(`(() => { const i = document.getElementById('find-input'); i.value = 'needle'; i.dispatchEvent(new Event('input')); return true; })()`);
  assert.ok(await until(() => L.shell(`document.getElementById('find-count').textContent === '1/1'`)));
  const first = await L.main(() => global.lumio.tabs.activeId);
  await L.main(() => global.lumio.cmd.newTab());
  assert.ok(await until(() => L.shell(`document.getElementById('findbar').hidden`)), 'not on the new tab');
  await L.main((_e, id) => { global.lumio.tabs.activate(id); return true; }, first);
  assert.ok(await until(() => L.shell(`!document.getElementById('findbar').hidden && document.getElementById('find-input').value === 'needle'`)), 'back with its words');
  // ⌘E: the page's selection becomes the search.
  await L.page(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('h1')); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`);
  await L.main(() => global.lumio.cmd.useSelectionForFind());
  assert.ok(await until(() => L.shell(`document.getElementById('find-input').value === 'find-one'`)));
  await L.shell(`document.getElementById('find-close').click(); true`);
  // Tidy up the new tab.
  await L.main((_e, id) => { const m = global.lumio.tabs; m.tabs.filter((t) => t.id !== id && t.url === 'lumio://newtab/').forEach((t) => m.close(t.id)); return true; }, first);
});

test('Open File… opens a page from disk; Save Page As saves complete, HTML only or a single file', async () => {
  const file = path.join(tmp, 'opened page.html');
  fs.writeFileSync(file, '<title>From disk</title><h1>Hello from a file</h1>');
  await L.main(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); return true; }, file);
  await L.main(() => global.lumio.cmd.openFile());
  assert.ok(await until(async () => (await title()) === 'From disk'));
  assert.equal(await L.main(() => global.lumio.tabs.wc().getURL()), pathToFileURL(file).href);

  await go(`${base}/save-me`, 'Page save-me');
  const saved = {};
  const names = { html: 'complete', htm: 'only', mhtml: 'single' };
  for (const ext of ['html', 'htm', 'mhtml']) {
    const out = path.join(tmp, `${names[ext]}.${ext}`);
    await L.main(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); return true; }, out);
    await L.main(() => global.lumio.cmd.savePage());
    assert.ok(await until(async () => fs.existsSync(out) && fs.statSync(out).size > 0), `${ext} saved`);
    saved[ext] = fs.readFileSync(out, 'utf8');
  }
  assert.match(saved.mhtml, /MIME-Version|Content-Type: multipart\/related/i, 'a single MHTML file');
  assert.match(saved.htm, /save-me/);
  assert.ok(await until(async () => fs.existsSync(path.join(tmp, 'complete_files'))), 'Complete keeps the page’s files next to it');
  assert.equal(fs.existsSync(path.join(tmp, 'only_files')), false, 'HTML only is just the page');
});

test('start pages and site zoom come back after a restart', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-nav-profile-'));
  try {
    let app = await launch({ profile });
    await until(() => app.main(() => !!global.lumio.tabs?.active), 15_000, app);
    await go(`${base}/zoom-later`, 'Page zoom-later', app);
    await app.main(() => { global.lumio.cmd.zoom(1); global.lumio.cmd.zoom(1); return true; });
    await app.main((_e, urls) => {
      global.lumio.store.setSetting('startup', 'pages');
      global.lumio.nav.setPref('startupPages', urls);
      global.lumio.store.flushAll();
      return true;
    }, [`${base}/start-one`, `${base}/start-two`]);
    await app.close();

    app = await launch({ profile });
    try {
      const urls = await until(() => app.main(() => { const t = global.lumio.tabs?.tabs; return t?.length === 2 && t.map((x) => x.pendingUrl || x.url); }), 15_000, app);
      assert.deepEqual(urls, [`${base}/start-one`, `${base}/start-two`]);
      await go(`${base}/zoom-later`, 'Page zoom-later', app);
      assert.ok(await until(async () => (await app.main(() => Math.round(global.lumio.tabs.wc().getZoomFactor() * 100))) === 125, 5000, app), 'the site kept 125%');
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
