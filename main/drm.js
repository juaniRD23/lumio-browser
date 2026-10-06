// Protected content (Widevine DRM, for Netflix, Spotify, Disney+…) on DRM
// builds of Lumio, which package castlabs' Electron for Content Security
// instead of stock Electron (LUMIO_DRM=1: build/drm.mjs, docs/drm.md).
// castlabs' `components` API downloads Google's Widevine module on the first
// launch and updates it in the background after that. A page that opens
// before it's ready can't play protected streams, so the first window waits
// for it, for 15 seconds at most. If that takes more than a second, a small
// window says "Getting protected content ready…"; Esc or Open now skips the
// wait. Stock Electron has no `components`, so there all of this does
// nothing: Lumio starts exactly as before and Settings shows no
// Protected content row.
const SLOW_MS = 1000; // the waiting window shows only after this
// It's made (hidden) a little before that: a first window's page process
// can take seconds to start on a slow Mac, and the window must be ready to
// show at the one-second mark, not seconds after it. A Widevine that's
// already there (every launch after the first) is ready long before this.
const PRELOAD_MS = 300;
const MAX_MS = 15000; // and Lumio never waits longer than this
const WAIT_URL = 'lumio://shell/drm-wait.html'; // renderer/ui/drm-wait.html
const WIDEVINE_ID = 'oimompecagnajdejgnnjijobebaeigek'; // Chromium's id for the Widevine component

// e2e tests run stock Electron. LUMIO_TEST_DRM_MS stands in for castlabs'
// API, with a Widevine download that takes that long.
function testComponents(ms) {
  let version = null;
  return {
    WIDEVINE_CDM_ID: WIDEVINE_ID,
    whenReady: () => new Promise((resolve) => setTimeout(() => { version = '4.10.0.0'; resolve([{ id: WIDEVINE_ID, status: 'updated', version }]); }, ms)),
    status: () => ({ [WIDEVINE_ID]: { status: version ? 'up-to-date' : 'new', title: 'Widevine Content Decryption Module', version } }),
  };
}

// castlabs' API, or null on stock Electron.
function componentsOf(electron, env) {
  const c = electron.components;
  if (c && typeof c.whenReady === 'function') return c;
  const ms = env.LUMIO_TEST ? Number(env.LUMIO_TEST_DRM_MS) : 0;
  return ms > 0 ? testComponents(ms) : null;
}

// What went wrong, from castlabs' ComponentsError (one error per component).
const describe = (err) => (Array.isArray(err?.errors) && err.errors.length ? err.errors.map((e) => e?.message || String(e)).join('; ') : err?.message || String(err));

function createDrm({ electron = require('electron'), theme, env = process.env, slowMs = SLOW_MS, maxMs = MAX_MS, preloadMs = Math.min(PRELOAD_MS, slowMs / 2), log = console } = {}) {
  let components; // looked up once the app is ready: castlabs' API needs that
  let state = 'starting'; // then 'ready' or 'failed'
  let pending = null;
  const api = () => (components === undefined ? (components = componentsOf(electron, env)) : components);
  // What happened when, in ms from the start of the wait (for tests, when the
  // waiting window is late): mark() adds main.js's own start-up steps.
  let started = null;
  const events = [];
  const mark = (what) => { if (started !== null && events.length < 50) events.push(`${Date.now() - started} ms ${what}`); };

  // The small "Getting protected content ready…" window. The page has no
  // script: Open now links to #skip, and Esc is caught here.
  function openWaiting(skip, over, wanted) {
    const win = new electron.BrowserWindow({
      width: 420, height: 180, show: false, frame: false, center: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      title: 'Getting protected content ready…',
      backgroundColor: theme ? theme.colors(theme.isDark()).frame : undefined,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const wc = win.webContents;
    wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); skip(); } });
    wc.on('did-navigate-in-page', (_e, url) => { if (url.endsWith('#skip')) skip(); });
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', skip);
    // Shown at the one-second mark, or as soon as it can be after that.
    win.lumioLoaded = false;
    win.once('ready-to-show', () => { mark('waiting window ready'); win.lumioLoaded = true; if (wanted()) showWaiting(win, over); });
    win.loadURL(WAIT_URL).catch(() => {});
    mark('waiting window made');
    return win;
  }
  function showWaiting(win, over) {
    if (!win || win.isDestroyed() || over() || !win.lumioLoaded || win.lumioShown) return;
    win.lumioShown = true;
    win.show();
    mark('waiting window shown');
  }

  // Resolves true when Widevine is ready, false when it isn't (stock
  // Electron, it failed, it's still downloading after MAX_MS, or the person
  // chose Open now). It never rejects.
  function whenReady() {
    if (pending) return pending;
    const c = api();
    if (!c) return (pending = Promise.resolve(false));
    started = Date.now();
    mark('waiting for Widevine');
    pending = new Promise((resolve) => {
      let done = false;
      let waiting = null;
      let slowPassed = false;
      const finish = () => {
        if (done) return;
        done = true;
        mark(`done (${state})`);
        clearTimeout(early);
        clearTimeout(slow);
        clearTimeout(cap);
        // Hidden now and closed once the browser's first window exists, so
        // Lumio is never left with no window at all (which ends a test run).
        if (waiting && !waiting.isDestroyed()) {
          const w = waiting;
          w.hide();
          electron.app.once('browser-window-created', () => setImmediate(() => { if (!w.isDestroyed()) w.destroy(); }));
        }
        resolve(state === 'ready');
      };
      const over = () => done;
      const open = () => { if (!waiting && !done) waiting = openWaiting(finish, over, () => slowPassed); };
      const early = setTimeout(open, preloadMs);
      const slow = setTimeout(() => { slowPassed = true; open(); showWaiting(waiting, over); }, slowMs);
      const cap = setTimeout(() => { log.warn(`[lumio] Widevine isn’t ready after ${Math.round(maxMs / 1000)} s; opening Lumio anyway.`); finish(); }, maxMs);
      let install;
      try { install = Promise.resolve(c.whenReady(c.WIDEVINE_CDM_ID ? [c.WIDEVINE_CDM_ID] : undefined)); } catch (err) { install = Promise.reject(err); }
      // It keeps going after a skip or the time limit; Settings shows how it ends.
      install
        .then(() => { state = 'ready'; }, (err) => { state = 'failed'; log.error('[lumio] Widevine couldn’t be set up:', describe(err)); })
        .then(finish);
    });
    return pending;
  }

  // For Settings › Site settings: { available: false } on stock Electron.
  function status() {
    const c = api();
    if (!c) return { available: false };
    let version = null;
    try { version = c.status()?.[c.WIDEVINE_CDM_ID]?.version || null; } catch { /* not registered yet */ }
    return { available: true, state, version };
  }

  return { whenReady, status, mark, timeline: () => [...events] };
}

// main.js: Widevine starts getting ready as soon as the app is (castlabs' API
// works only from then on), alongside the rest of the start-up, and the first
// window waits on whenReady().
function setup(app, opts = {}) {
  const drm = createDrm(opts);
  app.whenReady().then(() => drm.whenReady());
  return drm;
}

module.exports = { setup, createDrm, SLOW_MS, MAX_MS, PRELOAD_MS, WAIT_URL };
