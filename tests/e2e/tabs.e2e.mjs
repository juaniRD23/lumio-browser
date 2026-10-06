// End-to-end tests for tabs and sessions (nav-2): Back after a restart,
// "Restore pages?" after Lumio didn't quit properly, Reopen Closed Tab and
// closed windows with their history, Duplicate, the strip scrolling with many
// tabs, tab search across windows, the tab menu and Mute site, drops on the
// strip, pulling tabs out into a window and onto another one, several tabs
// at once, the Dock, the sad tab and the default-browser bar.
// Run: npm run test:e2e   (GitHub CI; set LUMIO_SHOTS=/some/dir for screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const MAC = process.platform === 'darwin';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-tabs-e2e-'));
let L;
let site;
let base;

const shot = async (name, app = L) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await app.shot(path.join(SHOTS, name + '.png')); } };
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
// The active tab's back/forward pages, as addresses.
const historyUrls = (app = L) => app.main(() => {
  const h = global.lumio.tabs.wc().navigationHistory;
  return { urls: h.getAllEntries().map((e) => e.url), index: h.getActiveIndex() };
});
// Leaves one window with one fresh tab, so each test starts the same way.
const reset = () => L.main(async () => {
  const wins = global.lumio.windows;
  for (const w of wins.slice(1)) w.close();
  const w = wins[0];
  global.lumio.focus(w);
  w.tabSelection = [];
  const keep = w.tabs.create('lumio://newtab/');
  for (const t of w.tabs.tabs.slice()) if (t.id !== keep.id) w.tabs.close(t.id);
  return true;
});

before(async () => {
  site = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/file.bin') {
      r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="dock.bin"', 'content-length': 4096 });
      r.end(Buffer.alloc(4096, 7));
      return;
    }
    const name = u.pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1>`);
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

test('Back still works after a restart, and the window comes back where it was', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-tabs-profile-'));
  try {
    let app = await launch({ profile });
    await until(() => app.main(() => !!global.lumio.tabs?.active), 15_000, app);
    await go(`${base}/r1`, 'Page r1', app);
    await go(`${base}/r2`, 'Page r2', app);
    await go(`${base}/r3`, 'Page r3', app);
    await app.main(() => global.lumio.tabs.wc().navigationHistory.goBack());
    assert.ok(await until(async () => (await title(app)).includes('Page r2'), 10_000, app));
    await app.close();

    app = await launch({ profile });
    try {
      const h = await until(async () => { const x = await historyUrls(app); return x.urls.some((u) => u.endsWith('/r3')) && x; }, 15_000, app);
      assert.ok(h, 'the tab came back with its history');
      assert.equal(h.urls[h.index], `${base}/r2`, 'on the page it was on');
      assert.ok(await until(async () => (await title(app)).includes('Page r2'), 10_000, app));
      await app.main(() => global.lumio.cmd.back());
      assert.ok(await until(async () => (await title(app)).includes('Page r1'), 10_000, app), 'Back works');
      await app.main(() => { global.lumio.cmd.forward(); return true; });
      await app.main(() => { global.lumio.cmd.forward(); return true; });
      assert.ok(await until(async () => (await title(app)).includes('Page r3'), 10_000, app), 'Forward works');
      const infobars = await app.main(() => global.lumio.infobars.list(global.lumio.current).map((b) => b.id));
      assert.deepEqual(infobars, [], 'a clean quit: no "Restore pages?" bar');
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('after Lumio didn’t quit properly, nothing reopens by itself and "Restore pages?" brings the tabs back', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-tabs-crash-'));
  try {
    let app = await launch({ profile });
    await until(() => app.main(() => !!global.lumio.tabs?.active), 15_000, app);
    await go(`${base}/c1`, 'Page c1', app);
    await go(`${base}/c2`, 'Page c2', app);
    await app.main((_e, u) => { global.lumio.tabs.create(u); return true; }, `${base}/c3`);
    assert.ok(await until(async () => (await title(app)).includes('Page c3'), 10_000, app));
    await app.wait(600); // the session saves a moment after tabs change
    await app.main(() => { global.lumio.store.flushAll(); return true; });
    // Killed, like a crash or a force quit: no clean quit happens.
    app.app.process().kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));

    app = await launch({ profile });
    try {
      await until(() => app.main(() => !!global.lumio.tabs?.active), 15_000, app);
      const urls = await app.main(() => global.lumio.tabs.tabs.map((t) => t.pendingUrl || t.url));
      assert.deepEqual(urls, ['lumio://newtab/'], 'nothing reopened by itself');
      const bar = await until(() => app.shell(`(() => { const b = document.querySelector('#infobars [data-bar="restore"]'); return b && b.textContent.replace(/\\s+/g, ' ').trim(); })()`), 10_000, app);
      assert.match(bar, /Restore pages\?.*didn’t shut down correctly/);
      const recent = await app.main(() => global.lumio.recentlyClosed.map((e) => e.kind));
      assert.deepEqual(recent, ['window'], 'the last session also waits in Recently Closed');
      await shot('tabs-01-restore-pages', app);
      await app.shell(`document.querySelector('#infobars [data-bar="restore"] [data-action="restore"]').click()`);
      const back = await until(async () => { const t = await app.main(() => global.lumio.tabs.tabs.map((x) => x.pendingUrl || x.url)); return t.length === 2 && t; }, 10_000, app);
      assert.deepEqual(back, [`${base}/c2`, `${base}/c3`], 'the tabs are back, in place of the unused new tab');
      assert.equal(await app.main(() => global.lumio.recentlyClosed.length), 0, 'no longer under Recently Closed');
      assert.equal(await app.shell(`document.querySelectorAll('#infobars .lumio-bar').length`), 0, 'the bar is gone');
      // The first tab kept its Back.
      await app.main(() => { const m = global.lumio.tabs; m.activate(m.tabs[0].id); return true; });
      assert.ok(await until(async () => (await title(app)).includes('Page c2'), 10_000, app));
      await app.main(() => global.lumio.cmd.back());
      assert.ok(await until(async () => (await title(app)).includes('Page c1'), 10_000, app), 'Back works in a restored tab');
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Reopen Closed Tab and Duplicate keep the tab’s back/forward history; a closed window reopens whole or one tab at a time', async () => {
  await reset();
  await go(`${base}/d1`, 'Page d1');
  await go(`${base}/d2`, 'Page d2');
  // Duplicate
  await L.main(() => { const w = global.lumio.current; global.lumio.tabStrip.duplicate(w, [w.tabs.activeId]); return true; });
  assert.equal(await L.main(() => global.lumio.tabs.tabs.length), 2);
  assert.ok(await until(async () => (await title()).includes('Page d2')));
  let h = await until(async () => { const x = await historyUrls(); return x.urls.includes(`${base}/d1`) && x; });
  assert.ok(h, 'the copy can go back');
  // Close it and reopen it
  await L.main(() => global.lumio.cmd.closeTab());
  await L.main(() => global.lumio.cmd.reopenTab());
  assert.ok(await until(async () => (await title()).includes('Page d2')));
  h = await until(async () => { const x = await historyUrls(); return x.urls.includes(`${base}/d1`) && x; });
  assert.ok(h, 'the reopened tab can go back');
  await L.main(() => global.lumio.cmd.back());
  assert.ok(await until(async () => (await title()).includes('Page d1')), 'Back works in the reopened tab');

  // A closed window: History › Recently Closed lists it with its tabs.
  const id = await L.main((_e, urls) => { const w = global.lumio.createWindow({ urls }); return w.id; }, [`${base}/w1`, `${base}/w2`]);
  await until(() => L.main((_e, x) => global.lumio.windows.find((w) => w.id === x)?.tabs.tabs.every((t) => !t.loading && t.title.startsWith('Page')), id));
  await L.main((_e, x) => { global.lumio.windows.find((w) => w.id === x).close(); return true; }, id);
  const entry = await until(() => L.main(() => { const e = global.lumio.recentlyClosed.at(-1); return e?.kind === 'window' && { tabs: e.tabs.map((t) => t.url), index: global.lumio.recentlyClosed.length - 1 }; }));
  assert.deepEqual(entry.tabs, [`${base}/w1`, `${base}/w2`]);
  // One tab of it…
  await L.main((_e, i) => { global.lumio.cmd.reopenClosed(i, 1); return true; }, entry.index);
  assert.ok(await until(() => L.main((_e, u) => global.lumio.tabs.tabs.some((t) => (t.pendingUrl || t.url) === u), `${base}/w2`)));
  // …then the rest as a window.
  const before = await L.main(() => global.lumio.windows.length);
  await L.main((_e, i) => { global.lumio.cmd.reopenClosed(i); return true; }, entry.index);
  assert.ok(await until(async () => (await L.main(() => global.lumio.windows.length)) === before + 1), 'the window reopened');
  await reset();
});

test('many tabs: the strip scrolls, the tab you’re on stays in view and + stays visible', async () => {
  await reset();
  await L.main(() => { for (let i = 0; i < 40; i++) global.lumio.tabs.create('lumio://newtab/', { active: false }); return true; });
  await L.main(() => { const m = global.lumio.tabs; m.activate(m.tabs.at(-1).id); return true; });
  const state = await until(() => L.shell(`(() => {
    const tabs = document.getElementById('tabs');
    if (!tabs.classList.contains('scrolls')) return null;
    const box = tabs.getBoundingClientRect();
    const a = tabs.querySelector('.tab.active').getBoundingClientRect();
    const plus = document.getElementById('newtab').getBoundingClientRect();
    return { inView: a.left >= box.left - 1 && a.right <= box.right + 1, plus: plus.width > 0 && plus.right <= innerWidth, fade: tabs.classList.contains('fade-start') };
  })()`));
  assert.ok(state, 'the strip scrolls');
  assert.ok(state.inView, 'the tab you’re on is in view');
  assert.ok(state.plus, 'the new tab button is visible');
  assert.ok(state.fade, 'the start fades (more tabs that way)');
  await shot('tabs-02-many-tabs');
  await reset();
});

test('tab search lists every window’s tabs; Enter switches to the tab and its window', async () => {
  await reset();
  await go(`${base}/alpha`, 'Page alpha');
  const other = await L.main((_e, u) => global.lumio.createWindow({ urls: [u] }).id, `${base}/bravo-search`);
  await until(() => L.main((_e, x) => global.lumio.windows.find((w) => w.id === x)?.tabs.active?.title === 'Page bravo-search', other));
  const first = await L.main(() => global.lumio.windows[0].id);
  await L.main((_e, x) => { const w = global.lumio.windows.find((y) => y.id === x); global.lumio.focus(w); w.focus(); return true; }, first);
  await L.main(() => { global.lumio.cmd.tabSearch(); return true; });
  const opened = await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'tabsearch'));
  assert.ok(opened, '⌘⇧A opens tab search');
  const ov = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
  assert.ok(await until(() => ov(`document.querySelectorAll('.ts-row').length >= 2`)));
  await shot('tabs-03-tab-search');
  await ov(`(() => { const i = document.getElementById('ts-input'); i.value = 'brvo'; i.dispatchEvent(new Event('input')); return true; })()`);
  assert.ok(await until(() => ov(`document.querySelector('.ts-row.sel .ts-title')?.textContent === 'Page bravo-search'`)), 'fuzzy search finds it');
  await ov(`document.getElementById('ts-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.current.id)) === other), 'its window is in front');
  await reset();
});

test('the tab menu has Chrome’s items; Mute site mutes every tab of that site, now and later', async () => {
  await reset();
  await go(`${base}/m1`, 'Page m1');
  const labels = await L.main(() => {
    const w = global.lumio.current;
    const menu = global.lumio.tabStrip.tabMenu(w, { id: w.tabs.activeId });
    const out = menu.items.map((i) => i.label).filter(Boolean);
    menu.closePopup(w.win);
    return out;
  });
  for (const l of ['New Tab to the Right', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Site', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', 'Reopen Closed Tab', 'Bookmark All Tabs']) {
    assert.ok(labels.includes(l), `has ${l}`);
  }
  assert.ok(labels.some((l) => /^Move Tab to (New|Another) Window$/.test(l)));
  // The other parts' items (main.js menuExtras): groups, reading list, split view, tabs to the side.
  assert.ok(labels.some((l) => /^Add Tab to (New )?Group$/.test(l)), 'tab groups');
  for (const l of ['Add Tab to Reading List', 'Add Tab to New Split View', 'Show Tabs to the Side']) assert.ok(labels.includes(l), `has ${l}`);
  // The strip's own menu (right-click between tabs) names the window.
  const strip = await L.main(() => {
    const w = global.lumio.current;
    const menu = global.lumio.tabStrip.stripMenu(w);
    const out = menu.items.map((i) => i.label).filter(Boolean);
    menu.closePopup(w.win);
    return out;
  });
  for (const l of ['New Tab', 'Reopen Closed Tab', 'Bookmark All Tabs', 'Name Window…', 'Show Tabs to the Side']) assert.ok(strip.includes(l), `the strip menu has ${l}`);
  const origin = new URL(base).origin;
  await L.main(() => { const w = global.lumio.current; global.lumio.tabStrip.run(w, 'mute', [w.tabs.activeId], w.tabs.activeId); return true; });
  assert.ok(await L.main((_e, o) => global.lumio.store.settings.mutedSites.includes(o), origin), 'remembered in settings');
  assert.ok(await L.main(() => global.lumio.tabs.wc().isAudioMuted()));
  await L.main((_e, u) => { global.lumio.tabs.create(u); return true; }, `${base}/m2`);
  assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().isAudioMuted())), 'a new tab of that site is muted too');
  await L.main(() => { const w = global.lumio.current; global.lumio.tabStrip.run(w, 'mute', [w.tabs.activeId], w.tabs.activeId); return true; });
  assert.equal(await L.main((_e, o) => global.lumio.store.settings.mutedSites.includes(o), origin), false, 'unmuted');
  assert.equal(await L.main(() => global.lumio.tabs.tabs.some((t) => t.view?.webContents.isAudioMuted())), false);
  await reset();
});

test('drops on the strip: on a tab it opens there, between tabs a new tab, text searches, scripts don’t run', async () => {
  await reset();
  await go(`${base}/drop-a`, 'Page drop-a');
  const onTab = await L.main((_e, u) => { const w = global.lumio.current; return global.lumio.tabStrip.drop(w, { on: w.tabs.activeId, index: 0, url: u }); }, `${base}/dropped`);
  assert.deepEqual(onTab, [`${base}/dropped`]);
  assert.ok(await until(async () => (await title()).includes('Page dropped')));
  assert.equal(await L.main(() => global.lumio.tabs.tabs.length), 1, 'no new tab');
  await L.main(() => { const w = global.lumio.current; global.lumio.tabStrip.drop(w, { on: null, index: 0, text: 'lumio tab strip' }); return true; });
  const tabs = await L.main(() => global.lumio.tabs.tabs.map((t) => t.pendingUrl || t.url));
  assert.equal(tabs.length, 2);
  assert.match(tabs[0], /search.*lumio/i, 'text searches, in a new tab at the drop');
  const bad = await L.main(() => { const w = global.lumio.current; return global.lumio.tabStrip.drop(w, { on: w.tabs.activeId, url: 'javascript:alert(1)', text: '' }); });
  assert.ok(bad.every((u) => !u.startsWith('javascript:')), 'never runs a script');
  await reset();
});

test('pulling a tab out makes a window with the same page; dropped on another window’s strip it joins it', async () => {
  await reset();
  await go(`${base}/tear-a`, 'Page tear-a');
  await L.main((_e, u) => { global.lumio.tabs.create(u); return true; }, `${base}/tear-b`);
  assert.ok(await until(async () => (await title()).includes('Page tear-b')));
  const info = await L.main(() => {
    const w = global.lumio.current;
    const tab = w.tabs.active;
    const b = w.win.getContentBounds();
    const win = global.lumio.tabDrag.start(w, { ids: [tab.id], screenX: b.x + 300, screenY: b.y + 300, grabX: 40, grabY: 20 });
    global.lumio.tabDrag.end({ screenX: b.x + 320, screenY: b.y + 320 });
    return { from: w.id, to: win?.id, tab: tab.id, wcId: tab.view.webContents.id };
  });
  assert.ok(info.to && info.to !== info.from, 'a new window');
  const moved = await L.main((_e, x) => { const w = global.lumio.windows.find((y) => y.id === x.to); const t = w.tabs.get(x.tab); return t && { wc: t.view.webContents.id, n: w.tabs.tabs.length, from: global.lumio.windows.find((y) => y.id === x.from).tabs.tabs.length }; }, info);
  assert.deepEqual(moved, { wc: info.wcId, n: 1, from: 1 }, 'the same page (not reloaded) in its own window');
  // Now drag the new window's only tab onto the first window's strip.
  const joined = await L.main((_e, x) => {
    const src = global.lumio.windows.find((y) => y.id === x.to);
    const dst = global.lumio.windows.find((y) => y.id === x.from);
    const c = dst.win.getContentBounds();
    const s = dst.stripRect || { x: 0, y: 0, width: c.width, height: 40 };
    global.lumio.tabDrag.start(src, { ids: [x.tab], screenX: c.x + s.x + 200, screenY: c.y + s.y + s.height / 2, grabX: 10, grabY: 10 });
    global.lumio.tabDrag.end({ screenX: c.x + s.x + 200, screenY: c.y + s.y + s.height / 2 });
    return dst.tabs.tabs.map((t) => t.id).includes(x.tab) && dst.tabs.get(x.tab).view.webContents.id === x.wcId;
  }, info);
  assert.ok(joined, 'it joined the other window, page and all');
  assert.ok(await until(async () => (await L.main(() => global.lumio.windows.length)) === 1), 'the emptied window closed');
  await reset();
});

test('several tabs at once: Shift-click a range, then close, pin or move them together', async () => {
  await reset();
  await L.main((_e, b) => { for (const n of ['s1', 's2', 's3', 's4']) global.lumio.tabs.create(`${b}/${n}`, { active: false }); return true; }, base);
  // Shift-click from the 2nd tab to the 4th, in the strip itself.
  await L.main(() => { const m = global.lumio.tabs; m.activate(m.tabs[1].id); return true; });
  await L.wait(300);
  const clicked = await L.shell(`(() => {
    const tabs = [...document.querySelectorAll('#tabs > .tab')];
    const r = tabs[3].getBoundingClientRect();
    tabs[3].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true, clientX: r.left + 10, clientY: r.top + 10, pointerId: 1 }));
    return true;
  })()`);
  assert.ok(clicked);
  const sel = await until(async () => { const s = await L.main(() => global.lumio.current.tabSelection || []); return s.length === 3 && s; });
  assert.ok(sel, 'three tabs selected');
  assert.equal(await L.shell(`document.querySelectorAll('#tabs > .tab.selected').length`), 3, 'they look selected');
  await shot('tabs-04-multi-select');
  await L.main(() => { const w = global.lumio.current; global.lumio.tabStrip.run(w, 'pin', global.lumio.tabStrip.targets(w, w.tabs.activeId), w.tabs.activeId); return true; });
  assert.equal(await L.main(() => global.lumio.tabs.tabs.filter((t) => t.pinned).length), 3, 'pinned together');
  await L.main(() => { global.lumio.cmd.closeTab(); return true; });
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === 2), '⌘W closed all three');
  await reset();
});

test('the Dock: a finished download counts on the icon until Downloads is opened', { skip: !MAC && 'macOS only' }, async () => {
  await reset();
  await go(`${base}/file.bin`);
  assert.ok(await until(async () => (await L.main((electron) => electron.app.dock.getBadge())) === '1', 15_000), 'a count on the Dock');
  await L.main(() => { global.lumio.cmd.downloads(); return true; });
  assert.ok(await until(async () => (await L.main((electron) => electron.app.dock.getBadge())) === ''), 'cleared by opening Downloads');
  await reset();
});

test('a crashed tab shows a sad face in the strip and its page; Reload brings the page back', async () => {
  await reset();
  await go(`${base}/before-crash`, 'Page before-crash');
  await go(`${base}/will-crash`, 'Page will-crash');
  await L.main(() => { global.lumio.tabs.wc().forcefullyCrashRenderer(); return true; });
  assert.ok(await until(() => L.main(() => global.lumio.tabs.active.crashed)), 'the tab knows it crashed');
  assert.ok(await until(() => L.shell(`!!document.querySelector('#tabs > .tab.active.crashed svg')`)), 'a sad face in the strip');
  assert.ok(await until(() => L.page(`document.getElementById('retry')?.textContent === 'Reload'`)), 'the sad tab page with Reload');
  await shot('tabs-05-sad-tab');
  await L.page(`document.getElementById('retry').click()`);
  assert.ok(await until(async () => (await title()).includes('Page will-crash')), 'the page is back');
  assert.equal(await L.main(() => global.lumio.tabs.active.crashed), false);
  await L.main(() => global.lumio.cmd.back());
  assert.ok(await until(async () => (await title()).includes('Page before-crash')), 'and its history');
  await reset();
});

test('the default-browser bar never shows in tests', async () => {
  const bars = await L.main(() => global.lumio.windows.flatMap((w) => global.lumio.infobars.list(w).map((b) => b.id)));
  assert.ok(!bars.includes('default-browser'));
});
