// Help (main/help.js): "Report an issue…" only sends what the person ticked,
// lumio://version's details, and lumio://flags-lite's experiments
// (main/flags.js), which become Chromium switches at the next launch.
// Electron is stubbed; the server side is in server/test/feedback.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-help-'));
let relaunched = 0;
let dialogAnswer = 0;
require.cache[require.resolve('electron')] = {
  id: 'electron', loaded: true,
  exports: {
    app: { getVersion: () => '0.6.7', getLocale: () => 'en-US', getPath: () => tmp, userAgentFallback: 'Mozilla/5.0 Test', relaunch: () => { relaunched++; }, quit() {} },
    dialog: { showMessageBox: async () => ({ response: dialogAnswer }) },
  },
};

const flags = require('../main/flags.js');
const { Help, buildReport, systemInfo, versionInfo, helpCenterUrl, releaseNotesUrl, MAX_DESCRIPTION } = require('../main/help.js');
const { parseInput } = require('../main/omnibox.js');

const settingsStore = (settings = {}) => ({ settings, setSetting(k, v) { this.settings[k] = v; } });

// ---------------------------------------------------------------- flags
test('experiments: defaults, switches, and a restart to apply', () => {
  assert.deepEqual(flags.values(), { smoothScrolling: true, forceDark: false, parallelDownloading: false });
  assert.deepEqual(flags.switchesFor({}), { switches: [], features: [] }, 'the defaults change nothing');
  assert.deepEqual(flags.switchesFor({ smoothScrolling: false, forceDark: true, parallelDownloading: true, bogus: true }), {
    switches: [['disable-smooth-scrolling']],
    features: ['WebContentsForceDark', 'ParallelDownloading'],
  });
  assert.deepEqual(flags.set({}, 'bogus', true), {}, 'only known experiments are saved');
  const saved = flags.set({}, 'forceDark', 1);
  assert.deepEqual(saved, { forceDark: true });

  // At startup: straight from settings.json, merged with features already asked for.
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ flags: { forceDark: true, smoothScrolling: false } }));
  const switches = new Map([['enable-features', 'Existing']]);
  const app = { commandLine: { appendSwitch: (k, v) => switches.set(k, v), getSwitchValue: (k) => switches.get(k) || '' } };
  flags.applyAtStartup(app, tmp);
  assert.equal(switches.get('enable-features'), 'Existing,WebContentsForceDark');
  assert.ok(switches.has('disable-smooth-scrolling'));
  assert.equal(flags.state({ forceDark: true, smoothScrolling: false }).restart, false, 'what it started with');
  const changed = flags.state({ forceDark: false, smoothScrolling: false });
  assert.equal(changed.restart, true);
  assert.deepEqual(changed.flags.map((f) => [f.id, f.value, f.default]), [['smoothScrolling', false, true], ['forceDark', false, false], ['parallelDownloading', false, false]]);

  // A first launch (no settings yet) starts with the defaults.
  const fresh = new Map();
  flags.applyAtStartup({ commandLine: { appendSwitch: (k, v) => fresh.set(k, v), getSwitchValue: () => '' } }, path.join(tmp, 'nothing'));
  assert.equal(fresh.size, 0);
});

test('chrome://version and chrome://flags open Lumio’s pages', () => {
  assert.equal(parseInput('chrome://version').url, 'lumio://version/');
  assert.equal(parseInput('chrome://flags').url, 'lumio://flags-lite/');
  assert.equal(parseInput('about:flags').url, 'lumio://flags-lite/');
});

// ---------------------------------------------------------------- the report
test('a report carries only what was ticked', () => {
  const ctx = { url: 'https://example.com/secret?token=1', shot: 'data:image/jpeg;base64,AAAA', system: { lumio: '0.6.7' } };
  assert.deepEqual(buildReport({ description: '  It froze  ' }, ctx), { description: 'It froze' }, 'nothing about the page by default');
  assert.deepEqual(buildReport({ description: 'x', includeUrl: true, includeShot: true, includeSystem: true, email: 'me@example.com' }, ctx), {
    description: 'x', email: 'me@example.com', url: ctx.url, screenshot: ctx.shot, system: ctx.system,
  });
  assert.deepEqual(buildReport({ description: 'x', includeUrl: 'yes', includeShot: 1 }, ctx), { description: 'x' }, 'only a real tick counts');
  assert.deepEqual(buildReport({ description: 'x', includeUrl: true, email: 'nope' }, { url: 'lumio://settings/' }), { description: 'x' }, 'Lumio’s own pages and bad emails are left out');
  assert.equal(buildReport({ description: 'y'.repeat(MAX_DESCRIPTION + 50) }).description.length, MAX_DESCRIPTION);
});

test('system info and lumio://version say what Lumio runs on', () => {
  const s = systemInfo();
  assert.deepEqual(Object.keys(s), ['lumio', 'chromium', 'electron', 'os', 'arch', 'language']);
  assert.equal(s.lumio, '0.6.7');
  assert.equal(s.language, 'en-US');
  const v = versionInfo();
  for (const k of ['name', 'version', 'chromium', 'electron', 'v8', 'node', 'os', 'userAgent', 'executable', 'profile', 'commandLine', 'notesUrl']) assert.ok(k in v, k);
  assert.equal(v.v8, process.versions.v8);
  assert.equal(v.profile, tmp);
  assert.equal(v.notesUrl, releaseNotesUrl('0.6.7'));
  assert.match(v.notesUrl, /^https:\/\/github\.com\/.+\/releases\/tag\/v0\.6\.7$/);
  assert.equal(helpCenterUrl('https://lumio.test'), 'https://lumio.test/#faq');
});

// A window with a page to report about.
function fakeWindow({ url = 'https://example.com/page', width = 1600 } = {}) {
  const img = (w) => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: Math.round(w * 0.6) }),
    resize: ({ width: nw }) => img(nw),
    toJPEG: () => Buffer.alloc(Math.round(w * 20), 1),
  });
  const w = {
    closed: false,
    incognito: false,
    overlayKind: null,
    shown: [],
    focused: 0,
    win: { getContentSize: () => [1200, 800] },
    tabs: {
      active: { url, view: { webContents: { isDestroyed: () => false, capturePage: async () => img(width) }, getBounds: () => ({ x: 0, y: 84, width: 1200, height: 700 }) } },
      displayUrl: (t) => t.url,
      wc: () => ({ focus: () => { w.focused++; } }),
    },
    overlay: { webContents: { focus() {} } },
    showOverlay(rect, payload) { this.overlayKind = payload.kind; this.shown.push({ rect, payload }); },
    hideOverlay() { this.overlayKind = null; },
  };
  return w;
}

function help({ api, signedIn = true } = {}) {
  const sent = [];
  const account = {
    base: 'https://lumio.test',
    state: () => (signedIn ? { signedIn: true, email: 'me@example.com' } : { signedIn: false }),
    api: async (p, opts) => { sent.push([p, opts]); return api ? api(p, opts) : { ok: true, status: 200, data: { ok: true } }; },
  };
  const opened = [];
  const h = new Help({ account, store: settingsStore({}), current: () => null, openUrl: (u) => opened.push(u), openInternal: (u) => opened.push(u) });
  return { h, sent, opened };
}

test('Report an issue: the dialog gets a small preview; the screenshot goes only if ticked', async () => {
  const { h, sent } = help();
  const w = fakeWindow();
  await h.openReport(w);
  const { rect, payload } = w.shown[0];
  assert.equal(payload.kind, 'feedback');
  assert.equal(payload.url, 'https://example.com/page');
  assert.equal(payload.email, 'me@example.com', 'the account’s email, to change or clear');
  assert.equal(payload.signedIn, true, 'the dialog says the account goes with it');
  assert.match(payload.thumb, /^data:image\/jpeg;base64,/);
  assert.ok(payload.thumb.length < w.feedback.shot.length, 'only a preview goes to the dialog');
  assert.ok(rect.width <= 460 + 24 && rect.y >= 84, 'over the page');
  assert.deepEqual(Object.keys(payload.system), Object.keys(systemInfo()));

  assert.deepEqual(await h.send(w, { description: '   ' }), { ok: false, error: 'Describe the issue first.' });
  assert.deepEqual(await h.send(w, { description: 'The page is blank', includeSystem: false }), { ok: true });
  assert.deepEqual(sent[0], ['/api/feedback', { method: 'POST', body: { description: 'The page is blank' } }]);
  assert.equal(w.feedback, null, 'the screenshot is let go after sending');
  assert.equal((await h.send(w, { description: 'again' })).ok, false, 'a report needs its dialog');

  await h.openReport(w);
  await h.send(w, { description: 'With everything', includeUrl: true, includeShot: true, includeSystem: true, email: 'other@example.com' });
  const body = sent[1][1].body;
  assert.equal(body.url, 'https://example.com/page');
  assert.match(body.screenshot, /^data:image\/jpeg;base64,/);
  assert.ok(body.screenshot.length < 1_400_000, 'within the server’s limit');
  assert.equal(body.email, 'other@example.com');
  assert.equal(body.system.lumio, '0.6.7');

  // Lumio's own pages: no address to offer.
  const page = fakeWindow({ url: 'lumio://settings/' });
  await h.openReport(page);
  assert.equal(page.shown[0].payload.url, '');
  h.closeReport(page);
  assert.equal(page.overlayKind, null);
  assert.equal(page.feedback, null);
  assert.equal(page.focused, 1, 'back to the page');
});

test('Report an issue: what the person sees when sending fails', async () => {
  const offline = help({ api: async () => { throw new Error('offline'); } });
  const w = fakeWindow();
  await offline.h.openReport(w);
  assert.match((await offline.h.send(w, { description: 'x y z' })).error, /Couldn’t reach Lumio/);
  const limited = help({ api: async () => ({ ok: false, status: 429, data: { error: 'Try again in an hour.' } }) });
  await limited.h.openReport(w);
  assert.deepEqual(await limited.h.send(w, { description: 'x y z' }), { ok: false, error: 'Try again in an hour.' });
  assert.ok(w.feedback, 'kept, to try again');
});

test('Help commands and the pages’ calls', async () => {
  const { h, opened } = help();
  const c = h.commands();
  c.helpCenter();
  c.whatsNew();
  c.versionPage();
  c.flagsPage();
  assert.deepEqual(opened, ['https://lumio.test/#faq', releaseNotesUrl('0.6.7'), 'lumio://version/', 'lumio://flags-lite/']);

  const handlers = {};
  h.register({ handle: (c2, fn) => { handlers[c2] = fn; }, on: (c2, fn) => { handlers[c2] = fn; }, internalHandle: (c2, hosts, fn) => { handlers[c2] = { hosts, fn }; } });
  assert.deepEqual(handlers['page:version-info'].hosts, ['version']);
  assert.deepEqual(handlers['page:flags'].hosts, ['flags-lite']);
  assert.equal(handlers['page:version-info'].fn({}).version, '0.6.7');
  const after = handlers['page:set-flag'].fn({}, 'forceDark', true);
  assert.equal(h.store.settings.flags.forceDark, true);
  assert.equal(after.flags.find((f) => f.id === 'forceDark').value, true);
  handlers['page:flags-reset'].fn({});
  assert.deepEqual(h.store.settings.flags, {});
  dialogAnswer = 1;
  assert.equal(await handlers['page:relaunch'].fn({ w: { win: {} } }), false, 'Cancel keeps Lumio running');
  dialogAnswer = 0;
  assert.equal(await handlers['page:relaunch'].fn({ w: { win: {} } }), true);
  assert.equal(relaunched, 1);
});
