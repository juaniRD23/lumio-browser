// End-to-end tests for links and pop-ups: the pop-up blocker and its address
// bar icon, sized pop-ups in their own window with a bar (window.opener,
// closing themselves, "Open in tab", their dialogs and permission prompts),
// links to other apps ("Open <App>?", mailto: without asking, schemes that
// never open), "Save … As…" always asking where, window management asking
// first, and sound waiting for a click.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lumio-popups-e2e-'));
const downloads = path.join(tmp, 'downloads');
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
const go = async (u, expect) => {
  await L.main((_e, x) => global.lumio.tabs.navigate(x), u);
  assert.ok(await until(async () => (await title()) === expect), `loaded ${expect}`);
};
const tabCount = () => L.main(() => global.lumio.tabs.tabs.length);
// Why a permission bubble didn't open (printed when it doesn't): the window's
// overlay, the chip, and where the shell's keyboard is.
const bubbleState = () => L.main(async () => {
  const w = global.lumio.current;
  const shell = await w.win.webContents.executeJavaScript(`({ active: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(), omnibox: document.getElementById('omnibox').className, chip: document.getElementById('perm-chip').hidden ? null : document.getElementById('perm-chip').textContent })`).catch((e) => e.message);
  return { overlayKind: w.overlayKind, overlayIn: w.overlayIn, overlaySeq: w.overlaySeq, url: w.tabs.wc()?.getURL(), pageFocused: w.tabs.wc()?.isFocused(), shellFocused: w.win.webContents.isFocused(), shell };
}).catch((e) => e.message);
// A real click in the active tab's page (it counts as the person's).
const clickPage = (sel) => L.main(async (_e, s) => {
  const wc = global.lumio.tabs.wc();
  const r = await wc.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`);
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
}, sel);
// The pop-up window, its page and its bar.
const popupCount = () => L.main(() => global.lumio.popups.length);
// (Its frame runs scripts at once: webContents.executeJavaScript() waits for a
// page to load, and a pop-up its opener writes into may never get one.)
const inPopup = (code) => L.main((_e, c) => global.lumio.popups[0].tabs.wc().mainFrame.executeJavaScript(c), code);
const inBar = (code) => L.main((_e, c) => global.lumio.popups[0].win.webContents.executeJavaScript(c), code);
const openPopup = async () => {
  await go(`${base}/opener`, 'Opener');
  await clickPage('#pay');
  assert.ok(await until(async () => (await popupCount()) === 1 && (await inPopup('document.title')) === 'Pay here'), 'the pop-up opened');
};
const closePopups = () => L.main(() => { for (const p of global.lumio.popups) for (const t of p.tabs.tabs) t.touched = false; global.lumio.popups.forEach((p) => p.close()); return true; });
// Stand-ins for the apps on this computer (their names), recording what would
// have opened: nothing really opens. restoreApps() puts Electron's own back.
const stubApps = () => L.main((electron) => {
  global.__realApps ??= { name: electron.app.getApplicationNameForProtocol, open: electron.shell.openExternal };
  global.__opened = [];
  const apps = { 'lumio-e2e': 'Test App.app', mailto: 'Mail.app', 'search-ms': 'Search.app', 'ms-settings': 'Settings.app' };
  electron.app.getApplicationNameForProtocol = (u) => apps[String(u).split(':')[0]] || '';
  electron.shell.openExternal = async (u) => { global.__opened.push(u); };
  return true;
});
const restoreApps = () => L.main((electron) => {
  const real = global.__realApps;
  if (real) {
    electron.app.getApplicationNameForProtocol = real.name;
    electron.shell.openExternal = real.open;
  }
  global.__realApps = null;
  return true;
});

const PAGES = {
  '/opener': `<title>Opener</title>
    <button id="pay" onclick="window.pop = window.open('/pay', 'pay', 'width=420,height=500')">Pay</button>
    <button id="tab" onclick="window.open('/target')">New tab</button>
    <a id="app" href="lumio-e2e://join?id=7">Join</a>
    <script>addEventListener('message', (e) => { if (e.origin === location.origin) document.title = 'Opener got ' + e.data; });</script>`,
  '/pay': `<title>Pay here</title><p>Paying</p><script>window.opener && window.opener.postMessage('paid', location.origin);</script>`,
  '/target': '<title>Target</title>',
  // Chrome asks for window management only after a click (transient
  // activation); without one, getScreenDetails() only checks, and rejects.
  '/screens': `<title>Screens</title><button id="screens" style="width:200px;height:60px" onclick="window.wm = null; getScreenDetails().then(() => { window.wm = 'yes'; }, (e) => { window.wm = e.name; })">Screens</button>`,
  // A pop-up whose page never arrives (204), which the opener writes into instead.
  '/spoof': `<title>Spoof</title>
    <button id="go" onclick="const w = window.open('/nothing', 'fake', 'width=420,height=500'); w.document.write('<title>Your bank</title><h1>Sign in to your bank</h1>')">Go</button>`,
  // A page with a frame from another site (localhost vs 127.0.0.1): its own process.
  '/embed': `<title>Embed</title><iframe id="f" src="http://localhost:PORT/frame" width="320" height="120" style="border:0"></iframe>`,
  '/frame': `<title>Frame</title><button id="b" style="width:200px;height:60px" onclick="window.open('/target')">Open</button>`,
  // An ad from another site that tries a pop-up every 100 ms, on a page with its own button.
  '/article': `<title>Article</title><button id="read" style="width:200px;height:60px">Read more</button>
    <iframe src="http://localhost:PORT/ad" width="320" height="120" style="border:0"></iframe>`,
  '/ad': `<title>Ad</title><script>setInterval(() => window.open('/target'), 100);</script>`,
  '/links': `<title>Links</title><style>a { display: block; margin: 12px; font-size: 20px }</style>
    <a id="mail" href="mailto:ada@example.com">Mail Ada</a>
    <a id="search" href="search-ms:query=passwords">Search this computer</a>
    <a id="settings" href="ms-settings:privacy">Privacy settings</a>`,
  '/files': `<title>Files</title><a id="report" href="/report.txt" style="display:block;margin:12px">Report</a>
    <img id="pic" src="/pic.png" width="80" height="80" style="margin:12px">`,
};
// Files to download: [content type, body, the file name the server gives (if any)].
const FILES = {
  '/report.txt': ['text/plain', 'The report', 'report.txt'],
  '/plain.txt': ['text/plain', 'Plain', 'plain.txt'],
  '/pic.png': ['image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')],
};

before(async () => {
  site = http.createServer((q, r) => {
    const { pathname } = new URL(q.url, 'http://x');
    if (FILES[pathname]) {
      const [type, body, name] = FILES[pathname];
      r.writeHead(200, { 'content-type': type, ...(name ? { 'content-disposition': `attachment; filename="${name}"` } : {}) });
      r.end(body);
      return;
    }
    if (pathname === '/nothing') { r.writeHead(204); r.end(); return; }
    const page = PAGES[pathname]?.replace('PORT', site.address().port);
    r.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
    r.end(page || 'not found');
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  fs.mkdirSync(downloads, { recursive: true });
  L = await launch({ env: { LUMIO_DOWNLOADS: downloads } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  await L?.main(() => { for (const w of [...global.lumio.windows, ...global.lumio.popups]) for (const t of w.tabs.tabs) t.touched = false; return true; }).catch(() => {});
  await closePopups().catch(() => {});
  await restoreApps().catch(() => {});
  await L?.close();
  site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pop-up blocker: a pop-up without a click is blocked and listed; a click opens one; a listed one opens on request', async () => {
  await go(`${base}/opener`, 'Opener');
  const openerId = await L.main(() => global.lumio.tabs.activeId);
  const before = await tabCount();
  await L.page(`setTimeout(() => { window.r = window.open('/target'); }, 0); true`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.active.blockedPopups?.length || 0)) === 1), 'listed');
  assert.equal(await tabCount(), before, 'no tab opened');
  assert.equal(await L.page('window.r'), null, 'window.open() returned null, like Chrome');
  assert.ok(await until(() => L.shell(`!document.getElementById('popups-btn').hidden`)), 'the address bar says so');
  await shot('80-popup-blocked');

  await clickPage('#tab');
  assert.ok(await until(async () => (await tabCount()) === before + 1), 'a click opens it');
  await L.main(() => { const t = global.lumio.tabs; t.close(t.activeId); });
  assert.ok(await until(async () => (await tabCount()) === before));

  // Picking it in the list: the page opens it again.
  await L.main((_e, id) => { const t = global.lumio.tabs; const tab = t.get(id); t.activate(id); t.openBlockedPopup(tab, tab.blockedPopups[0].id); }, openerId);
  assert.ok(await until(async () => (await tabCount()) === before + 1), 'the listed one opened');
  await L.main(() => { const t = global.lumio.tabs; t.close(t.activeId); });

  // Always allow the site: no click needed any more.
  await L.main((_e, id) => global.lumio.tabs.activate(id), openerId);
  await L.main((_e, origin) => global.lumio.profiles.normal.permissions.set(origin, 'popups', true), base);
  await L.page(`setTimeout(() => window.open('/target'), 0); true`);
  assert.ok(await until(async () => (await tabCount()) === before + 1), 'allowed site');
  await L.main(() => { const t = global.lumio.tabs; t.close(t.activeId); });
  await L.main((_e, origin) => global.lumio.profiles.normal.permissions.set(origin, 'popups', undefined), base);
});

test('a click on a button in a frame from another site opens its pop-up, the first click and the next', async () => {
  await go(`${base}/embed`, 'Embed');
  const before = await tabCount();
  // A real click on the frame's button: the frame's position plus the button's in it.
  // Sent the way the mouse's are (DevTools' Input domain), so Chromium routes
  // it into the frame's own process; sendInputEvent() only reaches the page's.
  const clickFrameButton = () => L.main(async () => {
    const wc = global.lumio.tabs.wc();
    const f = await wc.executeJavaScript(`(() => { const r = document.getElementById('f').getBoundingClientRect(); return { x: r.x, y: r.y } })()`);
    const frame = wc.mainFrame.frames[0];
    const b = await frame.executeJavaScript(`(() => { const r = document.getElementById('b').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`);
    const x = Math.round(f.x + b.x);
    const y = Math.round(f.y + b.y);
    wc.focus();
    const mouse = wc.debugger;
    if (!mouse.isAttached()) mouse.attach('1.3');
    try {
      await mouse.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await mouse.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 120)); // a person's click takes a moment
      await mouse.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } finally {
      mouse.detach();
    }
    return true;
  });
  const backToEmbed = () => L.main(() => { const t = global.lumio.tabs; t.close(t.activeId); const e = t.tabs.find((x) => x.title === 'Embed'); if (e) t.activate(e.id); });
  assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().mainFrame.frames.length === 1)));
  await clickFrameButton();
  assert.ok(await until(async () => (await tabCount()) === before + 1), 'the first click (focus goes into the frame)');
  await backToEmbed();
  await clickFrameButton();
  assert.ok(await until(async () => (await tabCount()) === before + 1), 'the next click (focus already in the frame)');
  await backToEmbed();
  assert.equal(await L.main(() => global.lumio.tabs.active.blockedPopups?.length || 0), 0, 'nothing was blocked');
});

test('a click on the page doesn’t let a frame from another site (an ad) open a pop-up', async () => {
  await go(`${base}/article`, 'Article');
  const before = await tabCount();
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.active.blockedPopups?.length || 0)) > 0), 'the ad’s tries are blocked');
  for (let i = 0; i < 3; i++) { await clickPage('#read'); await L.wait(400); }
  assert.equal(await tabCount(), before, 'no tab opened for the ad');
});

test('a sized pop-up opens in its own window with a bar, talks back to its page, and closes itself', async (t) => {
  t.after(closePopups); // none left over for the next test, even if this one fails
  await openPopup();
  assert.ok(await until(async () => (await title()) === 'Opener got paid'), 'window.opener works (postMessage)');
  const host = new URL(base).host;
  // about:blank until its page gets there (the opener could still be writing into it), then the page's address.
  assert.ok(await until(async () => (await inBar(`document.getElementById('address').value`)) === `http://${host}/pay`), 'its bar shows where it really is');
  assert.equal(await inBar(`document.getElementById('site-icon').textContent`), 'Not secure', 'plain http says so');
  const winTitle = () => L.main(() => global.lumio.popups[0].win.getTitle());
  if (!(await until(async () => (await winTitle()) === 'Pay here'))) console.error('pop-up window title:', await winTitle().catch((e) => e.message), '| its page’s:', await inPopup('document.title').catch((e) => e.message));
  assert.equal(await winTitle(), 'Pay here', 'the window’s title is the page’s');
  const b = await L.main(() => global.lumio.popups[0].tabs.active.view.getBounds());
  assert.equal(b.y, 40, 'the page is under the bar');
  assert.equal(b.width, 420, 'the width the page asked for');
  assert.ok(Math.abs(b.height - 500) <= 2, `the height the page asked for (${b.height})`);
  await shot('81-popup-window');
  await inPopup('window.close(); true');
  assert.ok(await until(async () => (await popupCount()) === 0), 'it closed itself');
  assert.equal(await L.page('window.pop.closed'), true, 'and the page that opened it knows');
});

test('a pop-up its opener writes into, whose page never arrives, says about:blank, not the address it asked for', async (t) => {
  t.after(closePopups);
  await go(`${base}/spoof`, 'Spoof');
  await clickPage('#go');
  assert.ok(await until(async () => (await popupCount()) === 1 && (await inPopup('document.title')) === 'Your bank'), 'the opener wrote into it');
  await L.wait(800); // long enough for the 204 to come back
  assert.equal(await inBar(`document.getElementById('address').value`), 'about:blank');
  assert.equal(await inBar(`document.getElementById('site-icon').classList.contains('clickable')`), false, 'no lock, no site');
});

test('a pop-up’s dialogs and permission prompts appear in the pop-up', async (t) => {
  t.after(closePopups); // none left over for the next test, even if this one fails
  await openPopup();
  await inPopup(`setTimeout(() => { window.r = confirm('Pay now?'); }, 0); true`);
  assert.ok(await until(() => L.main(() => {
    const p = global.lumio.popups[0];
    return p.tabs.active.dialogs?.[0]?.spec.kind === 'js' && p.win.contentView.children.includes(p.dialogs.view);
  })), 'confirm() over the pop-up’s page');
  await L.main(() => global.lumio.popups[0].dialogs.view.webContents.executeJavaScript(`document.querySelector('#d-buttons [data-id="ok"]').click(); true`));
  assert.equal(await until(() => inPopup('window.r')), true);

  // Notifications are quiet by default (batch 6: only the browser window's
  // address bar chip shows those), so this site's question must be one that asks.
  await L.main(() => global.lumio.profiles.normal.permissions.settings.setDefault('notifications', 'ask'));
  try {
    await inPopup(`Notification.requestPermission().then((p) => { window.perm = p; }); true`);
    assert.equal(await until(() => inBar(`!document.getElementById('permbar').hidden && document.querySelector('#permbar .infobar-text').textContent`)), `${new URL(base).host} wants to show notifications`);
    await inBar(`document.querySelector('#permbar [data-act=block]').click(); true`);
    assert.equal(await until(() => inPopup('window.perm')), 'denied');
  } finally {
    await L.main((_e, origin) => {
      const p = global.lumio.profiles.normal.permissions;
      p.set(origin, 'notifications', undefined);
      p.settings.setDefault('notifications', 'quiet');
    }, base);
  }
  await closePopups();
  assert.ok(await until(async () => (await popupCount()) === 0));
});

test('"Open in tab" moves the pop-up’s page into the browser window, still linked to its opener', async (t) => {
  t.after(closePopups); // none left over for the next test, even if this one fails
  await openPopup();
  const before = await tabCount();
  // Even if this fails, the tab it moved goes, so the next tests start on a live page.
  t.after(() => L.main((_e, n) => {
    const m = global.lumio.tabs;
    for (const tab of m.tabs.slice(n)) { tab.touched = false; m.close(tab.id, { force: true }); }
    if (m.tabs.length && !m.tabs.includes(m.active)) m.activate(m.tabs[0].id);
    return true;
  }, before));
  await inBar(`document.getElementById('open-tab').click(); true`);
  assert.ok(await until(async () => (await popupCount()) === 0), 'the pop-up window went');
  assert.equal(await tabCount(), before + 1);
  assert.equal(await title(), 'Pay here', 'its page is the tab you’re on');
  assert.equal(await L.page('!!window.opener'), true, 'still linked to the page that opened it');
  // Its page closing itself closes the tab, like Chrome.
  await L.page('window.close(); true');
  assert.ok(await until(async () => (await tabCount()) === before));
});

test('a link to another app asks "Open <App>?" in the tab; Always allow remembers the site', async () => {
  await stubApps();
  try {
    await go(`${base}/opener`, 'Opener');
    const dialog = () => L.main(() => { const d = global.lumio.tabs.active.dialogs?.[0]; return d ? { kind: d.spec.kind, title: d.spec.title, checkbox: d.spec.checkbox?.label || null } : null; });
    const answer = (button, checked = false) => L.main((_e, [b, c]) => { const w = global.lumio.current; const tab = w.tabs.active; w.tabs.answer(tab, tab.dialogs[0].id, { button: b, checked: c }); return true; }, [button, checked]);
    const opened = () => L.main(() => global.__opened.length);

    await clickPage('#app');
    const d = await until(dialog);
    assert.deepEqual(d, { kind: 'external', title: 'Open Test App?', checkbox: `Always allow ${new URL(base).host} to open links of this type in the associated app` });
    await shot('82-open-app');
    await answer('cancel');
    assert.equal(await opened(), 0, 'Cancel opens nothing');

    // Without another click the page can't ask again.
    await L.page(`location.href = 'lumio-e2e://join?id=8'; true`);
    await L.wait(800);
    assert.equal(await dialog(), null, 'no click, no prompt');

    await clickPage('#app');
    await until(dialog);
    await answer('open', true);
    assert.deepEqual(await until(() => L.main(() => global.__opened.length && global.__opened)), ['lumio-e2e://join?id=7']);
    assert.equal(await L.main((_e, origin) => global.lumio.profiles.normal.permissions.remembered(origin, 'openExternal:lumio-e2e'), base), true);

    // Remembered: the next click opens it without asking.
    await clickPage('#app');
    assert.ok(await until(async () => (await opened()) === 2));
    assert.equal(await dialog(), null);
  } finally {
    await L.main((_e, origin) => global.lumio.profiles.normal.permissions.set(origin, 'openExternal:lumio-e2e', undefined), base);
    await restoreApps();
  }
});

test('mailto: opens the mail app without asking; schemes that run things on the computer never open', async () => {
  await stubApps();
  try {
    await go(`${base}/links`, 'Links');
    const kinds = () => L.main(() => (global.lumio.tabs.active.dialogs || []).map((d) => d.spec.kind));
    const opened = () => L.main(() => global.__opened);
    await clickPage('#mail');
    assert.deepEqual(await until(async () => { const o = await opened(); return o.length && o; }), ['mailto:ada@example.com'], 'opened, like Chrome');
    assert.deepEqual(await kinds(), [], 'without asking');
    // Typed in the address bar (or a bookmark): the mail app too, and the page stays.
    await L.main(() => { global.lumio.tabs.navigate('mailto:bob@example.com'); return true; });
    assert.ok(await until(async () => (await opened()).length === 2));
    assert.equal((await opened())[1], 'mailto:bob@example.com');
    assert.equal(await title(), 'Links');
    // Windows search and settings links: never handed to an app, even right after a click.
    for (const sel of ['#search', '#settings']) {
      await clickPage(sel);
      await L.wait(800);
      assert.deepEqual(await kinds(), [], `${sel}: no question`);
    }
    assert.equal((await opened()).length, 2, 'nothing else opened');
    assert.equal(await title(), 'Links', 'and the page stayed');
  } finally {
    await restoreApps();
  }
});

test('"Save Link As…" and "Save Image As…" always ask where; a normal download goes to the folder', async () => {
  const chosen = path.join(tmp, 'chosen');
  fs.mkdirSync(chosen, { recursive: true });
  // The page's right-click menu is kept instead of shown. Whatever Lumio
  // leaves to Electron's Save dialog gets a folder here instead (standing
  // in for the person), so no real dialog opens.
  await L.main((electron, { dir, sep }) => {
    const real = electron.Menu.buildFromTemplate;
    global.__realBuild = real;
    global.__menu = null;
    electron.Menu.buildFromTemplate = function (template) {
      const menu = real.call(this, template);
      if (template.some((i) => i.label === 'Inspect Element')) { global.__menu = template; menu.popup = () => {}; }
      return menu;
    };
    global.__saves = [];
    global.__onDownload = (_e, item) => {
      const asked = !item.getSavePath();
      global.__saves.push({ name: item.getFilename(), asked, defaultPath: item.getSaveDialogOptions().defaultPath || '' });
      if (asked) item.setSavePath(dir + sep + item.getFilename());
    };
    global.lumio.profiles.normal.session.on('will-download', global.__onDownload);
    return true;
  }, { dir: chosen, sep: path.sep });
  try {
    await go(`${base}/files`, 'Files');
    // A real right-click on the page, and the item picked from its menu.
    const rightClick = (sel) => L.main(async (_e, s) => {
      const wc = global.lumio.tabs.wc();
      const r = await wc.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`);
      global.__menu = null;
      wc.focus();
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      return true;
    }, sel);
    const pick = async (label) => {
      assert.ok(await until(() => L.main((_e, l) => !!global.__menu?.some((i) => i.label === l), label)), `the menu has ${label}`);
      await L.main((_e, l) => { global.__menu.find((i) => i.label === l).click(); return true; }, label);
    };
    const saved = (name) => until(() => L.main((_e, n) => global.__saves.find((x) => x.name === n), name));

    await rightClick('#report');
    await pick('Save Link As…');
    const link = await saved('report.txt');
    assert.equal(link?.asked, true, 'the Save dialog decides where it goes');
    assert.equal(path.basename(link.defaultPath), 'report.txt', 'it starts with the file’s name…');
    assert.equal(path.dirname(link.defaultPath), downloads, '…in the download folder');

    await rightClick('#pic');
    await pick('Save Image As…');
    assert.equal((await saved('pic.png'))?.asked, true);

    // Downloads go straight to the folder by default; only "Save … As…" asks.
    await L.main((_e, u) => { global.lumio.tabs.wc().downloadURL(u); return true; }, `${base}/plain.txt`);
    assert.equal((await saved('plain.txt'))?.asked, false);

    const done = () => L.main(() => global.lumio.profiles.normal.downloads.items.filter((d) => d.state === 'completed').map((d) => d.path).sort());
    assert.deepEqual(await until(async () => { const d = await done(); return d.length === 3 && d; }), [path.join(chosen, 'pic.png'), path.join(chosen, 'report.txt'), path.join(downloads, 'plain.txt')].sort(), 'each where it was saved, as the downloads list shows');
    assert.equal(fs.readFileSync(path.join(chosen, 'report.txt'), 'utf8'), 'The report');
  } finally {
    await L.main((electron) => {
      if (global.__realBuild) electron.Menu.buildFromTemplate = global.__realBuild;
      global.lumio.profiles.normal.session.removeListener('will-download', global.__onDownload);
      return true;
    });
  }
});

test('window management asks first; sound waits for a click', async () => {
  // Sound first: the click below leaves the site with user activation.
  await go(`${base}/target`, 'Target');
  // Chrome's autoplay rule: no sound until you click or type in the page.
  assert.equal(await L.page('new AudioContext().state'), 'suspended');
  await clickPage('body');
  assert.equal(await until(() => L.page(`(() => { const c = new AudioContext(); return c.state === 'running' && c.state; })()`)), 'running');

  // Window management: a click on the page asks.
  await go(`${base}/screens`, 'Screens');
  await clickPage('#screens');
  // The browser window asks in the address bar's chip and its bubble (batch 6), not a bar.
  if (!(await until(() => L.main(() => ((w) => w.overlayKind === 'permission' && w.overlayIn === w.overlaySeq)(global.lumio.current))))) {
    const page = await L.page(`(async () => ({ wm: window.wm, active: navigator.userActivation.isActive, been: navigator.userActivation.hasBeenActive, status: (await navigator.permissions.query({ name: 'window-management' }).catch((e) => ({ state: e.message }))).state }))()`).catch((e) => e.message);
    const setting = await L.main((_e, o) => global.lumio.profiles.normal.permissions.settings.value(o, 'windowManagement'), base).catch((e) => e.message);
    console.error('window management, no bubble:', JSON.stringify({ ...(await bubbleState()), page, setting }));
  }
  assert.ok(await L.main(() => ((w) => w.overlayKind === 'permission' && w.overlayIn === w.overlaySeq)(global.lumio.current)), 'the bubble opens by itself');
  const bubble = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
  assert.match(await until(() => bubble(`document.querySelector('.pb [data-d=block]') && document.querySelector('.pb').innerText`)), new RegExp(`${new URL(base).host.replace(/\./g, '\\.')} wants to[\\s\\S]*Manage windows on all your displays`, 'i'));
  assert.equal(await L.shell(`!document.getElementById('perm-chip').hidden`), true, 'the chip shows');
  assert.equal(await L.page('window.wm'), null, 'the page waits for the answer');
  await bubble(`document.querySelector('.pb [data-d=block]').click(); true`);
  try {
    assert.equal(await until(() => L.page('window.wm')), 'NotAllowedError');
  } finally {
    await L.main((_e, origin) => global.lumio.profiles.normal.permissions.set(origin, 'windowManagement', undefined), base);
  }
});
