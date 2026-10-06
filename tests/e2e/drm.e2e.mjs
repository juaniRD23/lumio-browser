// DRM (Widevine) in the real app (main/drm.js). e2e runs use stock Electron:
//   - a normal launch has no waiting window, and Settings › Site settings
//     has no protected content row, exactly as before;
//   - with LUMIO_TEST_DRM_MS standing in for castlabs' components API, the
//     first window waits for Widevine: "Getting protected content ready…"
//     shows after a second and goes away once the browser's window is
//     there, and Settings says Widevine is ready;
//   - Open now in that window opens the browser without waiting, while
//     Widevine keeps downloading; so does Esc;
//   - quitting while it waits quits, instead of opening the browser;
//   - only Settings can ask about it.
// Run: node --test --test-concurrency=1 tests/e2e/drm.e2e.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launch } from '../../scripts/launch.mjs';

const TITLE = 'Getting protected content ready…';
let L;

const until = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};
// The waiting windows (by title) and how many browser windows are open.
const windows = () => L.main(({ BrowserWindow }, title) => ({
  waiting: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle() === title).map((w) => ({ visible: w.isVisible() })),
  browser: global.lumio.windows.length,
}), TITLE);
const browserOpen = () => L.main(() => !!global.lumio.tabs?.active);
// The waiting window, visible. It's made a little before the one-second mark
// and shown at it (main/drm.js); a slow CI Mac can still take seconds over
// the first window's page process, so this allows for that, and says what
// happened when (main/drm.js's timeline) if it never came.
const waitingShows = async (ms = 8000) => {
  const w = await until(async () => { const x = await windows(); return x.waiting.some((y) => y.visible) ? x : null; }, ms);
  if (!w) console.log('[diag] no waiting window:', JSON.stringify(await L.main(({ BrowserWindow }) => ({
    timeline: global.lumio.drmTimeline(),
    windows: BrowserWindow.getAllWindows().map((x) => ({ title: x.getTitle(), visible: x.isVisible(), url: x.webContents.getURL() })),
    uptime: Math.round(process.uptime() * 1000),
  })).catch((e) => String(e))));
  return w;
};
// Every test closes its app, even when it fails, so the next one starts on
// an idle machine instead of next to a leftover Lumio.
const closeApp = async () => {
  const l = L;
  L = null;
  if (l) await Promise.race([l.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
};
const protectedContent = async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), 'lumio://settings/#privacy');
  await until(() => L.page(`document.readyState === 'complete' && !!document.getElementById('privacy')`));
  await L.wait(500); // protected-content.js asked the browser
  return L.page(`({ shown: !!document.getElementById('protected-content'), state: document.getElementById('pc-state')?.textContent || null })`);
};

after(closeApp);

test('a normal build: no waiting window, and Settings has no protected content row', async () => {
  L = await launch();
  try {
    assert.ok(await until(browserOpen), 'the browser opens');
    assert.deepEqual((await windows()).waiting, []);
    assert.deepEqual(await protectedContent(), { shown: false, state: null });
  } finally { await closeApp(); }
});

test('a DRM build’s first launch: the browser waits for Widevine behind a short waiting window, then Settings says it’s ready', async () => {
  // A download long enough that the waiting window is sure to have its turn
  // (with 4 s, a slow CI Mac's first window could take longer than that, and
  // then rightly never show).
  L = await launch({ env: { LUMIO_TEST_DRM_MS: '9000' } });
  try {
    const early = await waitingShows();
    assert.ok(early, `“${TITLE}” shows`);
    assert.equal(early.browser, 0, 'before the browser’s window');
    assert.ok(await until(browserOpen), 'then the browser opens');
    assert.ok(await until(async () => (await windows()).waiting.length === 0, 3000), 'and the waiting window is gone');
    assert.deepEqual(await protectedContent(), { shown: true, state: 'Ready · Widevine 4.10.0.0' });
    // Other Lumio pages can't ask (and websites have no bridge at all).
    await L.main((_e, u) => global.lumio.tabs.navigate(u), 'lumio://history/');
    assert.ok(await until(() => L.page(`document.readyState === 'complete' && !!window.lumioPage`)));
    assert.match(await L.page(`window.lumioPage.invoke('page:protected-content').then(() => 'answered', (e) => String(e?.message || e))`), /Not allowed/);
  } finally { await closeApp(); }
});

test('Open now skips the wait; Widevine keeps downloading', async () => {
  L = await launch({ env: { LUMIO_TEST_DRM_MS: '60000' } });
  try {
    assert.ok(await waitingShows(), 'the waiting window shows');
    const t = Date.now();
    await L.main(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)
      .webContents.executeJavaScript(`document.querySelector('a.btn').click(); true`), TITLE);
    assert.ok(await until(browserOpen, 8000), 'the browser opens');
    assert.ok(Date.now() - t < 8000, 'without waiting out the 15-second limit');
    assert.ok(await until(async () => (await windows()).waiting.length === 0, 3000), 'the waiting window is gone');
    assert.deepEqual(await protectedContent(), { shown: true, state: 'Getting ready… Lumio is downloading Google’s Widevine module.' });
  } finally { await closeApp(); }
});

test('quitting while it waits quits Lumio (it doesn’t open the browser and get stuck)', async () => {
  L = await launch({ env: { LUMIO_TEST_DRM_MS: '60000' } });
  let quit = false;
  try {
    assert.ok(await waitingShows(), 'the waiting window shows');
    const proc = L.app.process();
    const exited = new Promise((r) => proc.once('exit', () => r(true)));
    // Cmd+Q: before-quit, then every window closes (the waiting one included).
    await L.main(({ app }) => { setTimeout(() => app.quit(), 50); return true; }).catch(() => {});
    quit = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 10_000))]);
    assert.equal(quit, true, 'Lumio quit');
    assert.doesNotMatch(L.logs.join(''), /\[lumio\] (uncaught|unhandled)/);
  } finally {
    if (quit) { fs.rmSync(L.userData, { recursive: true, force: true }); L = null; } else await closeApp();
  }
});

test('Esc in the waiting window opens the browser at once too', async () => {
  L = await launch({ env: { LUMIO_TEST_DRM_MS: '60000' } });
  try {
    assert.ok(await waitingShows(), 'the waiting window shows');
    const t = Date.now();
    // A real key press in that window: main/drm.js catches it before the page does.
    await L.main(({ BrowserWindow }, title) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === title);
      w.focus();
      w.webContents.focus();
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      return true;
    }, TITLE);
    assert.ok(await until(browserOpen, 8000), 'the browser opens');
    assert.ok(Date.now() - t < 8000, 'without waiting out the 15-second limit');
    assert.ok(await until(async () => (await windows()).waiting.length === 0, 3000), 'the waiting window is gone');
    assert.equal((await protectedContent()).state, 'Getting ready… Lumio is downloading Google’s Widevine module.', 'Widevine keeps downloading');
  } finally { await closeApp(); }
});
