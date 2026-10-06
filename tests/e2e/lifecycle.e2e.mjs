// End-to-end tests for the app's lifecycle: "Press Esc to exit full screen"
// and "Press Esc to show your cursor" over the page, files opened from Finder
// or the Dock, asking before quitting or closing Incognito cancels
// downloads, and the credits and legal pages (lumio://credits, Help menu,
// Settings › About).
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lumio-lifecycle-e2e-'));
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
const go = async (u, expect, ms) => {
  await L.main((_e, x) => global.lumio.tabs.navigate(x), u);
  assert.ok(await until(async () => (await title()) === expect, ms), `loaded ${expect}`);
};
// What the notice over the page says, and whether it's showing. The "·"
// between the site and "Press Esc…" is drawn by CSS (#n-action::before),
// which innerText leaves out, so it's read from the computed style.
const READ_NOTICE = `(() => {
  const $ = (id) => document.getElementById(id);
  if ($('bubble').hidden) return '';
  const sep = getComputedStyle($('n-action'), '::before').content;
  return [$('n-title').innerText, sep.startsWith('"') ? JSON.parse(sep) : '', $('n-action').innerText].join(' ');
})()`;
const notice = () => L.main(async (_e, js) => {
  const n = global.lumio.current.notice;
  const shown = !!n.view && global.lumio.win.contentView.children.includes(n.view);
  const text = shown && n.ready ? await n.view.webContents.executeJavaScript(js) : '';
  return { shown, text: text.replace(/\s+/g, ' ').trim(), data: n.data };
}, READ_NOTICE);
const pressEsc = () => L.main(() => {
  const wc = global.lumio.tabs.wc();
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  return true;
});
// Downloads that never finish (until the test is done with them).
const slow = new Set();
// The downloads question is answered by the test (Cancel), never a real box.
const answerCancel = () => L.main(() => { global.__asked = []; global.lumio.answerDownloads = (box) => { global.__asked.push(box); return 1; }; return true; });
const stopDownloads = () => L.main(() => {
  global.lumio.answerDownloads = null;
  // lumio.profiles also holds the registry, the list, open()…: only the sessions' profiles have downloads.
  const P = global.lumio.profiles;
  for (const p of new Set([P.normal, P.incognito, global.__incProfile])) for (const d of p?.downloads?.items || []) if (d.state === 'progressing') d.item.cancel();
  return true;
});
const PAGES = {
  '/video': '<title>Video</title><div id="v" style="width:400px;height:200px;background:#333"></div>',
  '/game': '<title>Game</title><canvas id="c" width="400" height="200"></canvas>',
  '/page': '<title>Plain page</title><p>Hello</p>',
};

before(async () => {
  site = http.createServer((q, r) => {
    const { pathname } = new URL(q.url, 'http://x');
    if (pathname === '/slow.bin') {
      r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"', 'content-length': String(50_000_000) });
      r.write(Buffer.alloc(64 * 1024));
      slow.add(r);
      return;
    }
    r.writeHead(PAGES[pathname] ? 200 : 404, { 'content-type': 'text/html' });
    r.end(PAGES[pathname] || 'not found');
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  fs.mkdirSync(path.join(tmp, 'downloads'), { recursive: true });
  L = await launch({ env: { LUMIO_DOWNLOADS: path.join(tmp, 'downloads') } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  await stopDownloads().catch(() => {});
  for (const r of slow) r.destroy();
  await L?.close();
  site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a page in full screen: "<site> is now full screen · Press Esc to exit full screen" over it, and Esc leaves', async () => {
  await go(`${base}/video`, 'Video');
  await L.main(() => global.lumio.tabs.wc().executeJavaScript('document.getElementById("v").requestFullscreen().then(() => true)', true));
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.fullscreenTab)) !== null), 'the page is full screen');
  const n = await until(async () => { const x = await notice(); return x.shown && x.text && x });
  assert.equal(n.text, `127.0.0.1:${site.address().port} is now full screen · Press Esc to exit full screen`);
  // On top of the page, at its top center.
  const place = await L.main(() => {
    const w = global.lumio.current;
    const kids = w.win.contentView.children;
    const page = w.tabs.active.view.getBounds();
    const b = w.notice.view.getBounds();
    return { top: kids.indexOf(w.notice.view) > kids.indexOf(w.tabs.active.view), centered: Math.abs(b.x + b.width / 2 - (page.x + page.width / 2)) <= 1, y: b.y - page.y };
  });
  assert.deepEqual(place, { top: true, centered: true, y: 8 });
  await shot('90-fullscreen-notice');
  await pressEsc();
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.fullscreenTab)) === null), 'Esc left full screen');
  assert.ok(await until(async () => !(await notice()).shown), 'and the notice went with it');
  await until(() => L.main(() => !global.lumio.win.isFullScreen()), 5000); // the Mac's animation
  // The page itself left too (on a Mac it used to stay full screen inside the
  // normal window, and its next request got no notice).
  const left = await until(async () => (await L.page('!document.fullscreenElement')) === true, 8000);
  if (!left) {
    console.error('the page is still full screen:', JSON.stringify(await L.main(() => ({
      window: global.lumio.win.isFullScreen(), tab: global.lumio.tabs.fullscreenTab, view: global.lumio.tabs.active.view.getBounds(), content: global.lumio.win.getContentBounds(),
    })).catch((e) => e.message)));
  }
  assert.ok(left, 'and the page left full screen too');
});

test('the notice goes by itself after a few seconds', async () => {
  // The video page (already open after the test above, unless that one was skipped).
  if (!(await L.main(() => global.lumio.tabs.wc().getURL())).endsWith('/video')) await go(`${base}/video`, 'Video');
  // The window must be out of full screen first. On CI's Macs leaving it (the
  // Spaces animation) took longer than the test above waits, and a page that
  // asks while the window is still on its way out gets nothing from Electron
  // (IsFullscreenForTabOrPending is true during an HTML full-screen
  // transition): no enter-html-full-screen, so no notice to see.
  const fsState = () => L.main(() => ({ window: global.lumio.win.isFullScreen(), tab: global.lumio.tabs.fullscreenTab, notice: global.lumio.current.notice.data }));
  if (!(await until(async () => !(await fsState()).window, 20_000))) console.error('still full screen before asking again:', JSON.stringify(await fsState()));
  await L.wait(1500); // the end of the animation, after the window's style changes
  await L.main(() => global.lumio.tabs.wc().executeJavaScript('document.getElementById("v").requestFullscreen().then(() => true)', true));
  if (!(await until(async () => (await notice()).shown))) {
    console.error('no notice:', JSON.stringify({ ...(await fsState()), page: await L.page('!!document.fullscreenElement').catch((e) => e.message), view: await L.main(() => ({ made: !!global.lumio.current.notice.view, ready: global.lumio.current.notice.ready })) }));
  }
  assert.ok((await notice()).shown, 'the notice shows');
  assert.ok(await until(async () => !(await notice()).shown, 8000), 'gone after about four seconds, still in full screen');
  assert.notEqual(await L.main(() => global.lumio.tabs.fullscreenTab), null);
  await pressEsc();
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.fullscreenTab)) === null));
  await until(() => L.main(() => !global.lumio.win.isFullScreen()), 5000);
});

test('a page that hides the pointer: "Press Esc to show your cursor"', async () => {
  await go(`${base}/game`, 'Game');
  await L.main(() => { const wc = global.lumio.tabs.wc(); wc.focus(); return wc.executeJavaScript('document.getElementById("c").requestPointerLock(); true', true); });
  const n = await until(async () => { const x = await notice(); return x.shown && x.text && x });
  assert.equal(n.text, 'Press Esc to show your cursor');
  await shot('91-pointer-notice');
  await pressEsc();
  await L.main(() => { global.lumio.current.notice.hide(); return true; });
});

test('files from Finder or the Dock open in a new tab; kinds Lumio can’t show are left to macOS', async () => {
  const page = path.join(tmp, 'from finder.html');
  fs.writeFileSync(page, '<title>From Finder</title><h1>Hi</h1>');
  const zip = path.join(tmp, 'archive.zip');
  fs.writeFileSync(zip, 'PK');
  const open = (file) => L.main((electron, f) => {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    electron.app.emit('open-file', e, f);
    return e.defaultPrevented;
  }, file);
  const before = await L.main(() => global.lumio.tabs.tabs.length);
  assert.equal(await open(page), true, 'Lumio opens it');
  assert.ok(await until(async () => (await title()) === 'From Finder'));
  assert.match(await L.main(() => global.lumio.tabs.wc().getURL()), /^file:\/\/.*from%20finder\.html$/);
  assert.equal(await L.main(() => global.lumio.tabs.tabs.length), before + 1);
  // The same file again: another tab, like Chrome.
  await open(page);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === before + 2));
  assert.equal(await open(zip), false, 'not handled: macOS says Lumio can’t open it');
  assert.equal(await L.main(() => global.lumio.tabs.tabs.length), before + 2);
  await L.main(() => { const t = global.lumio.tabs; t.close(t.activeId); t.close(t.activeId); return true; });
});

test('quitting with a download in progress asks first; Cancel keeps Lumio and the download going', async () => {
  await go(`${base}/page`, 'Plain page');
  try {
    await L.main((_e, u) => global.lumio.tabs.wc().downloadURL(u), `${base}/slow.bin`);
    assert.ok(await until(() => L.main(() => global.lumio.profiles.normal.downloads.inProgress() === 1)), 'downloading');
    await answerCancel();
    await L.main((electron) => { electron.app.quit(); return true; });
    const asked = await until(() => L.main(() => global.__asked.length && global.__asked));
    const quit = process.platform === 'darwin' ? 'Quit' : 'Exit';
    assert.equal(asked[0].message, `1 download is in progress. ${quit} anyway?`);
    assert.deepEqual([asked[0].buttons, asked[0].defaultId], [[quit, 'Cancel'], 1]);
    await L.wait(500);
    assert.equal(await L.main(() => global.lumio.windows.length > 0 && global.lumio.profiles.normal.downloads.inProgress()), 1, 'still running, still downloading');
  } finally {
    await stopDownloads();
  }
});

test('closing the last Incognito window with a download asks; Cancel keeps it (and its last tab), Close cancels the download', async () => {
  try {
    // A normal download too: ending Incognito leaves it going.
    await L.main((_e, u) => global.lumio.tabs.wc().downloadURL(u), `${base}/slow.bin?normal`);
    assert.ok(await until(() => L.main(() => global.lumio.profiles.normal.downloads.inProgress() === 1)));
    await answerCancel();
    await L.main((_e, u) => { global.__inc = global.lumio.createWindow({ incognito: true, urls: [u] }); return true; }, `${base}/page`);
    assert.ok(await until(() => L.main(() => global.__inc.tabs.wc()?.getTitle() === 'Plain page')));
    await L.main((_e, u) => { global.__incProfile = global.lumio.profiles.incognito; global.__inc.tabs.wc().downloadURL(u); return true; }, `${base}/slow.bin?incognito`);
    assert.ok(await until(() => L.main(() => global.__incProfile.downloads.inProgress() === 1)));
    await L.main(() => { global.__inc.close(); return true; });
    const asked = await until(() => L.main(() => global.__asked.length && global.__asked));
    assert.equal(asked[0].message, '1 download is in progress. Close Incognito anyway?');
    assert.deepEqual(asked[0].buttons, ['Close', 'Cancel']);
    assert.equal(await L.main(() => global.__inc.closed), false, 'Cancel keeps the window');
    // Closing its last tab is closing the window: the same question, and the tab stays.
    await L.main(() => { global.__asked = []; global.__inc.tabs.close(global.__inc.tabs.activeId); return true; });
    assert.ok(await until(() => L.main(() => global.__asked.length === 1)));
    assert.equal(await L.main(() => global.__inc.tabs.tabs.length), 1);
    // Close: the window goes and its download is canceled with Incognito.
    await L.main(() => { global.lumio.answerDownloads = () => 0; global.__inc.close(); return true; });
    assert.ok(await until(() => L.main(() => global.__inc.closed)));
    assert.ok(await until(() => L.main(() => global.__incProfile.downloads.items[0].state === 'cancelled')));
    assert.equal(await L.main(() => global.lumio.profiles.normal.downloads.inProgress()), 1, 'normal downloads go on');
  } finally {
    await L.main(() => { if (global.__inc && !global.__inc.closed) { global.lumio.answerDownloads = () => 0; global.__inc.close(); } return true; });
    await until(() => L.main(() => !global.__inc || global.__inc.closed));
    await stopDownloads();
  }
});

test('Windows: closing the last window (which quits) with a download asks first', { skip: process.platform !== 'win32' && 'closing the last window quits on Windows only' }, async () => {
  assert.equal(await L.main(() => global.lumio.windows.length), 1);
  try {
    await L.main((_e, u) => global.lumio.tabs.wc().downloadURL(u), `${base}/slow.bin?windows`);
    assert.ok(await until(() => L.main(() => global.lumio.profiles.normal.downloads.inProgress() === 1)));
    await answerCancel();
    await L.main(() => { global.lumio.current.close(); return true; });
    const asked = await until(() => L.main(() => global.__asked.length && global.__asked));
    assert.equal(asked[0].message, '1 download is in progress. Exit anyway?');
    assert.equal(await L.main(() => global.lumio.windows.length), 1, 'Cancel keeps it open');
  } finally {
    await stopDownloads();
  }
});

test('lumio://credits lists the open-source software with its licenses; Chromium’s notices open from it', async () => {
  await go('lumio://credits/', 'Credits');
  assert.ok(await until(async () => (await L.page("document.querySelectorAll('#packages details').length")) >= 5), 'the packages Lumio ships');
  assert.deepEqual(await L.page("[...document.querySelectorAll('.links a')].map((a) => a.href)"), await L.main(() => [global.lumio.account.url('/terms'), global.lumio.account.url('/privacy'), 'https://github.com/juaniRD23/lumio-browser']));
  assert.match(await L.page("document.querySelector('#engine .ver').textContent"), /^\d+\./, 'Chromium’s version');
  await shot('92-credits');
  await L.page("document.querySelector('#engine a').click(); true");
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())) === 'lumio://credits/chromium.html', 20_000));
  assert.ok(await until(async () => (await L.page("document.querySelectorAll('.product').length")) > 100, 20_000), 'hundreds of projects');
  assert.equal(await L.page("getComputedStyle(document.querySelector('.product .license')).display"), 'block', 'every license shown');
});

test('Help › Open-Source Licenses and Settings › About lead to the credits, Terms and Privacy Policy', async () => {
  await go(`${base}/page`, 'Plain page');
  await L.main((electron) => {
    const help = electron.Menu.getApplicationMenu().items.find((i) => i.role === 'help');
    help.submenu.items.find((i) => i.label === 'Open-Source Licenses').click();
    return true;
  });
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())).startsWith('lumio://credits/')));
  await go('lumio://settings/#about', 'Settings');
  assert.ok(await until(async () => (await L.page("document.getElementById('legal-terms').href")) === (await L.main(() => global.lumio.account.url('/terms')))));
  assert.equal(await L.page("document.getElementById('legal-privacy').href"), await L.main(() => global.lumio.account.url('/privacy')));
});
