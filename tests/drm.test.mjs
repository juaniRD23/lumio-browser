// DRM (Widevine) builds: the build switch in build/drm.mjs (which Electron to
// package, how to VMP-sign it and in what order), the app side in
// main/drm.js with stand-ins for castlabs' components API, the release
// workflows' guards, and in headless Chrome the "Getting protected content
// ready…" window and Settings › Site settings › Protected content IDs
// (skipped when Google Chrome isn't installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { luminance, contrast } from './colors.mjs';
import {
  drmSwitch, castlabsTag, isCastlabs, signingSteps, buildPlan, vmpCommand, CASTLABS_MIRROR, appElectron, installedElectron,
} from '../build/drm.mjs';
const require = createRequire(import.meta.url);
const { createDrm, setup, WAIT_URL } = require('../main/drm.js');
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the build switch
test('the switch: off unless LUMIO_DRM=1, or CI with both EVS secrets; LUMIO_DRM=0 always wins', () => {
  const on = (env) => drmSwitch(env).on;
  assert.equal(on({}), false, 'a normal build');
  assert.equal(on({ LUMIO_DRM: '' }), false);
  for (const v of ['1', 'true', 'TRUE', ' yes ']) assert.equal(on({ LUMIO_DRM: v }), true, v);
  const evs = { EVS_ACCOUNT_NAME: 'lumio', EVS_PASSWD: 'x' };
  assert.equal(on({ CI: 'true', ...evs }), true, 'CI with the EVS secrets');
  assert.equal(on({ CI: 'true', EVS_ACCOUNT_NAME: 'lumio' }), false, 'only one secret');
  assert.equal(on({ CI: 'true', EVS_ACCOUNT_NAME: 'lumio', EVS_PASSWD: '' }), false, 'an empty secret');
  assert.equal(on(evs), false, 'the secrets on this Mac don’t make every local build a DRM one');
  assert.equal(on({ CI: 'true', ...evs, LUMIO_DRM: '0' }), false, 'turned off on purpose');
  assert.deepEqual(drmSwitch({ CI: 'true', ...evs }), { on: true, why: 'CI with the EVS secrets' });
});

// castlabs' tags as `git ls-remote` showed them on 2026-10-05.
const TAGS = ['v44.5.1+wvcus', 'v44.1.0+wvcus', 'v44.0.0-alpha.9+wvcus', 'v43.7.7+wvcus', 'v43.5.0+wvcus', 'v43.2.0+wvcus', 'v43.0.0+wvcus', 'v43.0.0-beta.1+wvcus', 'v42.11.0+wvcus', 'v42.0.0+wvcus', 'v41.9.9-wvvmp'];

test('castlabs’ Electron: the same version when castlabs built it, else their newest stable build of that major', () => {
  assert.deepEqual(castlabsTag('43.7.7', TAGS), { tag: 'v43.7.7+wvcus', version: '43.7.7+wvcus', source: 'https://github.com/castlabs/electron-releases#v43.7.7+wvcus', exact: true });
  assert.deepEqual(castlabsTag('^43.8.1', TAGS), { tag: 'v43.7.7+wvcus', version: '43.7.7+wvcus', source: 'https://github.com/castlabs/electron-releases#v43.7.7+wvcus', exact: false }, 'no 43.8.1 yet');
  assert.equal(castlabsTag('43.3.0', TAGS).tag, 'v43.7.7+wvcus', 'newest of the major, not the nearest');
  assert.equal(castlabsTag('44.0.0', TAGS).tag, 'v44.5.1+wvcus', 'never an alpha');
  assert.equal(castlabsTag('42.11.0', TAGS).tag, 'v42.11.0+wvcus', 'numbers compare as numbers');
  assert.equal(castlabsTag('45.0.0', TAGS), null, 'no build of that major yet');
  assert.equal(castlabsTag('41.9.9', TAGS), null, 'old wvvmp builds don’t count');
  assert.equal(castlabsTag('latest', TAGS), null);
  assert.ok(isCastlabs('43.7.7+wvcus') && !isCastlabs('43.7.7') && !isCastlabs(undefined));
  assert.match(appElectron(), /^\d+\.\d+\.\d+$/, 'package.json pins stock Electron, like before');
  assert.equal(castlabsTag(appElectron(), [`v${appElectron()}+wvcus`]).exact, true);
});

test('signing steps: unchanged without DRM; VMP signing comes before code signing and notarizing', () => {
  // What build/package.mjs did before DRM.
  assert.deepEqual(signingSteps({}), ['ad-hoc-sign']);
  assert.deepEqual(signingSteps({ signId: 'Developer ID Application: Lumio' }), ['developer-id-sign']);
  assert.deepEqual(signingSteps({ signId: 'Developer ID Application: Lumio', notary: true }), ['developer-id-sign', 'notarize']);
  assert.deepEqual(signingSteps({ notary: true }), ['ad-hoc-sign'], 'no notarizing without a Developer ID');
  // DRM builds.
  assert.deepEqual(signingSteps({ drm: true }), ['vmp-sign', 'ad-hoc-sign']);
  assert.deepEqual(signingSteps({ drm: true, signId: 'Developer ID Application: Lumio', notary: true }), ['vmp-sign', 'developer-id-sign', 'notarize']);
});

const CASTLABS = { version: '43.7.7+wvcus', checksums: { 'electron-v43.7.7+wvcus-darwin-arm64.zip': 'acd8f0b6' } };
const SIGNED = { MACOS_SIGN_IDENTITY: 'Developer ID Application: Lumio', APPLE_API_KEY_PATH: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' };

test('a normal build packages exactly what it did before', () => {
  const plan = buildPlan({ env: SIGNED, appElectron: '43.7.7', installed: { version: '43.7.7', checksums: {} } });
  assert.deepEqual(plan, { drm: false, why: 'LUMIO_DRM isn’t set', electron: '43.7.7', packager: {}, mac: ['developer-id-sign', 'notarize'] });
  assert.deepEqual(buildPlan({ env: {}, appElectron: '43.7.7', installed: { version: '43.7.7' }, windows: true }).mac, ['ad-hoc-sign'], 'Windows packages build as before');
  // castlabs' Electron left in node_modules by an earlier DRM build: still stock Electron in the app.
  const leftover = buildPlan({ env: {}, appElectron: '43.7.7', installed: CASTLABS });
  assert.deepEqual(leftover.packager, { electronVersion: '43.7.7' });
  assert.deepEqual(leftover.mac, ['ad-hoc-sign']);
});

test('a DRM build packages castlabs’ Electron from castlabs’ releases, checked against their checksums', () => {
  const plan = buildPlan({ env: { ...SIGNED, LUMIO_DRM: '1' }, appElectron: '43.7.7', installed: CASTLABS });
  assert.equal(plan.drm, true);
  assert.deepEqual(plan.packager, {
    electronVersion: '43.7.7+wvcus',
    download: { mirrorOptions: { mirror: 'https://github.com/castlabs/electron-releases/releases/download/' }, checksums: CASTLABS.checksums },
    asarIntegrityDigest: false, // EVS signs castlabs' own Electron Framework only
  });
  assert.equal(CASTLABS_MIRROR, plan.packager.download.mirrorOptions.mirror);
  assert.deepEqual(plan.mac, ['vmp-sign', 'developer-id-sign', 'notarize']);
  const noSums = buildPlan({ env: { LUMIO_DRM: '1' }, appElectron: '43.7.7', installed: { version: '43.5.0+wvcus', checksums: null } });
  assert.deepEqual(noSums.packager.download, { mirrorOptions: { mirror: CASTLABS_MIRROR } }, 'then @electron/get reads castlabs’ SHASUMS256.txt');
});

test('a DRM build never quietly ships without Widevine: stock or mismatched Electron stops it, and so does Windows', () => {
  const env = { LUMIO_DRM: '1' };
  assert.throws(() => buildPlan({ env, appElectron: '43.7.7', installed: { version: '43.7.7' } }), /needs castlabs' Electron, but node_modules has stock Electron 43\.7\.7\. Run: node build\/drm\.mjs --install-electron/);
  assert.throws(() => buildPlan({ env, appElectron: '43.7.7', installed: null }), /no Electron/);
  assert.throws(() => buildPlan({ env, appElectron: '44.1.0', installed: CASTLABS }), /doesn't match the app's Electron 44\.1\.0/);
  // Windows is paused, and its VMP signing would come after code signing.
  assert.throws(() => buildPlan({ env, appElectron: '43.7.7', installed: CASTLABS, windows: true }), /^Error: DRM builds are Mac only for now: use --release --mac\.$/);
});

test('the EVS command signs the folder the app is in, never asks on CI, and can use another Python', () => {
  assert.deepEqual(vmpCommand({ env: {}, dir: '/dist/Lumio Browser-darwin-arm64', name: 'Lumio Browser' }),
    ['python3', ['-m', 'castlabs_evs.vmp', 'sign-pkg', '--name-hint', 'Lumio Browser', '/dist/Lumio Browser-darwin-arm64']]);
  assert.deepEqual(vmpCommand({ env: { CI: 'true', EVS_PYTHON: 'python' }, dir: '/dist/Lumio Beta-darwin-x64', name: 'Lumio Beta' }),
    ['python', ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', '--name-hint', 'Lumio Beta', '/dist/Lumio Beta-darwin-x64']]);
  assert.equal(vmpCommand({ env: { EVS_PYTHON: '/Users/me/.evs/bin/python' }, dir: 'x', name: 'y' })[0], '/Users/me/.evs/bin/python');
});

test('Widevine can load without weakening the app: only the Plugin helper turns off library validation, like Chrome', () => {
  // Chromium loads the Google-signed Widevine module in the Plugin helper.
  // @electron/osx-sign signs that helper with Chromium's plugin entitlements
  // unless build/package.mjs gives it others, which it doesn't.
  const pluginDefaults = fs.readFileSync(path.join(ROOT, 'node_modules', '@electron', 'osx-sign', 'entitlements', 'default.darwin.plugin.plist'), 'utf8');
  assert.match(pluginDefaults, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/);
  const sign = fs.readFileSync(path.join(ROOT, 'node_modules', '@electron', 'osx-sign', 'dist', 'sign.js'), 'utf8');
  assert.match(sign, /filePath\.includes\('\(Plugin\)\.app'\)\) \{\s*entitlementsFile = path\.resolve\(entitlementsFolder, 'default\.darwin\.plugin\.plist'\)/);
  const src = read('build/package.mjs');
  const perFile = src.slice(src.indexOf('optionsForFile: (file) => {'), src.indexOf('\n    },', src.indexOf('optionsForFile: (file) => {')));
  assert.match(perFile, /\n {6}return \{ hardenedRuntime: true \};$/, 'Electron’s helpers keep osx-sign’s entitlements');
  assert.match(perFile, /entitlements: path\.join\(root, 'build', 'entitlements\.mac\.plist'\)/, 'the app keeps its own, DRM or not');
  assert.doesNotMatch(read('build/entitlements.mac.plist'), /disable-library-validation/, 'the app keeps library validation');
});

test('build/package.mjs follows the plan: every step has a handler, and the packager gets the DRM options', () => {
  const src = read('build/package.mjs');
  const block = src.slice(src.indexOf('const MAC_STEPS = {'), src.indexOf('};', src.indexOf('const MAC_STEPS = {')));
  for (const step of new Set([true, false].flatMap((drm) => [...signingSteps({ drm, signId: 'x', notary: true }), ...signingSteps({ drm })]))) {
    assert.ok(block.includes(`'${step}':`) || block.includes(`  ${step}:`), `a handler for ${step}`);
  }
  assert.match(src, /for \(const step of PLAN\.mac\) await MAC_STEPS\[step\]\(app\);/);
  assert.match(src, /\.\.\.PLAN\.packager/);
  // A DRM build that would package Windows too stops before installing castlabs' Electron.
  assert.match(src, /const WITH_WINDOWS = arg\('--release'\) && !arg\('--mac'\);\nif \(drmSwitch\(process\.env\)\.on && !WITH_WINDOWS\) ensureCastlabsElectron\(\);\nconst PLAN = buildPlan\(\{ [^\n]*windows: WITH_WINDOWS \}\);/);
  assert.doesNotMatch(src.slice(src.indexOf('async function buildWindows')), /vmp|PLAN\./i, 'the Windows build is untouched');
  assert.equal(JSON.parse(read('package.json')).devDependencies.electron, appElectron(), 'package.json keeps stock Electron');
});

test('the release workflows change nothing without the EVS secrets, and never hold a credential', () => {
  for (const file of ['.github/workflows/release.yml', '.github/workflows/beta.yml']) {
    const yml = read(file).replace(/^\s*#.*\n/gm, ''); // comments may mention castlabs
    const jobs = yml.split(/\n {2}(?=[\w-]+:\n)/).filter((j) => /runs-on:/.test(j));
    assert.ok(jobs.some((j) => /runs-on: macos-/.test(j)), `${file}: a Mac job`);
    for (const job of jobs.filter((j) => !/runs-on: macos-/.test(j))) {
      assert.doesNotMatch(job, /EVS|castlabs|LUMIO_DRM|setup-python/, `${file}: DRM builds are Mac only (Windows is paused)`);
    }
    for (const job of jobs.filter((j) => /runs-on: macos-/.test(j))) {
      assert.match(job, /HAS_EVS: \$\{\{ secrets\.EVS_ACCOUNT_NAME != '' && secrets\.EVS_PASSWORD != '' && !contains\(fromJSON\('\["0","false","no"\]'\), vars\.LUMIO_DRM\) \}\}/, `${file}: the job knows whether EVS is set up, and every "off" LUMIO_DRM value turns it off (like build/drm.mjs)`);
      const steps = job.split(/\n {6}- /).slice(1);
      const drmSteps = steps.filter((s) => /castlabs|EVS_|LUMIO_DRM|setup-python/.test(s));
      assert.ok(drmSteps.length >= 2, `${file}: DRM steps`);
      for (const step of drmSteps) {
        const guarded = /\n {8}if: (always\(\) && )?env\.HAS_EVS == 'true'/.test(step) || /\[ "\$HAS_EVS" = true \] && python -m castlabs_evs\.account --no-ask deauth \|\| true/.test(step);
        assert.ok(guarded, `${file}: only with the EVS secrets:\n${step}`);
      }
      const signIn = drmSteps.find((s) => /reauth/.test(s));
      assert.match(signIn, /EVS_ACCOUNT_NAME: \$\{\{ secrets\.EVS_ACCOUNT_NAME \}\}\n {10}EVS_PASSWD: \$\{\{ secrets\.EVS_PASSWORD \}\}/);
      assert.match(signIn, /echo "LUMIO_DRM=1" >> "\$GITHUB_ENV"/);
      // The build step after it is the one that packages.
      assert.ok(steps.indexOf(signIn) < steps.findIndex((s) => /node build\/package\.mjs --release/.test(s)));
    }
    for (const [line] of yml.matchAll(/^.*EVS_PASSW.*$/gm)) assert.match(line, /^\s*(EVS_PASSWD: \$\{\{ secrets\.EVS_PASSWORD \}\}|HAS_EVS: .*)$/, `${file}: the password only ever comes from the secret`);
  }
});

test('the build reads which Electron node_modules has, and castlabs’ checksums when they’re there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-drm-'));
  try {
    assert.equal(installedElectron(dir), null, 'no Electron installed');
    const electron = path.join(dir, 'node_modules', 'electron');
    fs.mkdirSync(electron, { recursive: true });
    fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '43.7.7' }));
    assert.deepEqual(installedElectron(dir), { version: '43.7.7', checksums: null }, 'stock Electron: @electron/get reads SHASUMS256.txt');
    fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '43.7.7+wvcus' }));
    fs.writeFileSync(path.join(electron, 'checksums.json'), JSON.stringify(CASTLABS.checksums));
    assert.deepEqual(installedElectron(dir), CASTLABS, 'castlabs’ Electron, with its checksums');
    assert.deepEqual(buildPlan({ env: { LUMIO_DRM: '1' }, appElectron: '43.7.7', installed: installedElectron(dir) }).packager.download.checksums, CASTLABS.checksums);
    fs.writeFileSync(path.join(electron, 'package.json'), '{broken');
    assert.equal(installedElectron(dir), null, 'unreadable: treated as none, so a DRM build stops');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('docs/drm.md matches the workflows and the build: the secrets, the off switch, the log lines and the commands', () => {
  const docs = read('docs/drm.md');
  const steps = docs.slice(docs.indexOf('## One-time steps'), docs.indexOf('## How the build switch works'));
  for (const file of ['.github/workflows/release.yml', '.github/workflows/beta.yml']) {
    const yml = read(file);
    for (const [, name] of yml.matchAll(/secrets\.(EVS_\w+)/g)) assert.ok(steps.includes('`' + name + '`'), `${file} reads secrets.${name}: the owner’s steps say to add it`);
    assert.match(yml, /!contains\(fromJSON\('\["0","false","no"\]'\), vars\.LUMIO_DRM\)/);
  }
  assert.match(steps, /repository \*\*variable\*\* \(not a secret\) named `LUMIO_DRM`, set to `0`/);
  for (const off of ['0', 'false', 'no']) assert.equal(drmSwitch({ CI: 'true', EVS_ACCOUNT_NAME: 'a', EVS_PASSWD: 'b', LUMIO_DRM: off }).on, false, `${off} really turns it off, as the workflows' guard does`);
  // The test build's log lines, as build/package.mjs prints them.
  const pkg = read('build/package.mjs');
  assert.match(pkg, /console\.log\(`DRM build \(\$\{PLAN\.why\}\): castlabs Electron \$\{PLAN\.electron\}`\)/);
  assert.match(pkg, /console\.log\(`VMP signing \$\{path\.basename\(folder\)\} with castlabs EVS…`\)/);
  const plan = buildPlan({ env: { LUMIO_DRM: '1' }, appElectron: appElectron(), installed: { version: `${appElectron()}+wvcus` } });
  assert.match(steps, new RegExp(`DRM build \\(${plan.why}\\): castlabs Electron \\d+\\.\\d+\\.\\d+\\+wvcus`));
  assert.match(steps, /VMP signing … with castlabs EVS/);
  // verify-pkg checks the same app name the build signs with.
  const [, args] = vmpCommand({ dir: '/x', name: 'Lumio Browser' });
  assert.ok(args.includes('--name-hint') && steps.includes('castlabs_evs.vmp verify-pkg --name-hint "Lumio Browser"'));
  assert.match(pkg, /'vmp-sign': \(app\) => vmpSign\(path\.dirname\(app\), APP\)/);
  // The useful commands are the two build/drm.mjs knows: --install-electron, and anything else prints the status.
  const flags = new Set([...docs.matchAll(/node build\/drm\.mjs (--[\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...flags].sort(), ['--install-electron', '--status']);
  assert.match(read('build/drm.mjs'), /if \(process\.argv\.includes\('--install-electron'\)\) \{[\s\S]*\} else \{[\s\S]*console\.log\(`DRM build: /);
});

// ---------------------------------------------------------------- main/drm.js
function standIns({ components, env = {} } = {}) {
  const windows = [];
  const app = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.shown = false;
      this.hidden = false;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: (fn) => { this.openHandler = fn; } });
      windows.push(this);
      app.emit('browser-window-created', {}, this);
    }
    loadURL(url) { this.url = url; setImmediate(() => this.emit('ready-to-show')); return Promise.resolve(); }
    show() { this.shown = true; }
    hide() { this.hidden = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const logs = [];
  const log = { warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) };
  const theme = { isDark: () => true, colors: (dark) => ({ frame: dark ? '#070708' : '#f3f3f5' }) };
  const drm = createDrm({ electron: { app, BrowserWindow, ...(components ? { components } : {}) }, theme, env, slowMs: 40, maxMs: 400, log });
  return { drm, windows, app, BrowserWindow, logs };
}

// castlabs' components API: Widevine installs after `ms`, or fails.
function castlabs({ ms = 0, fail = null } = {}) {
  const c = {
    WIDEVINE_CDM_ID: 'oimompecagnajdejgnnjijobebaeigek',
    asked: [],
    version: null,
    whenReady(required) {
      c.asked.push(required);
      return new Promise((resolve, reject) => setTimeout(() => { if (fail) reject(fail); else { c.version = '4.10.2830.0'; resolve([]); } }, ms));
    },
    status: () => ({ [c.WIDEVINE_CDM_ID]: { status: c.version ? 'up-to-date' : 'new', title: 'Widevine Content Decryption Module', version: c.version } }),
  };
  return c;
}

test('stock Electron: nothing waits, no window opens, and Settings hears there’s no protected content', async () => {
  const { drm, windows } = standIns();
  const t = Date.now();
  assert.equal(await drm.whenReady(), false);
  assert.ok(Date.now() - t < 20, 'at once');
  await wait(80);
  assert.equal(windows.length, 0);
  assert.deepEqual(drm.status(), { available: false });
  assert.equal(drm.whenReady(), drm.whenReady(), 'asked once');
});

test('castlabs, Widevine already there: ready at once, no waiting window', async () => {
  const c = castlabs({ ms: 5 });
  const { drm, windows } = standIns({ components: c });
  assert.deepEqual(drm.status(), { available: true, state: 'starting', version: null });
  assert.equal(await drm.whenReady(), true);
  assert.deepEqual(c.asked, [['oimompecagnajdejgnnjijobebaeigek']], 'only Widevine is required');
  await wait(80);
  assert.equal(windows.length, 0);
  assert.deepEqual(drm.status(), { available: true, state: 'ready', version: '4.10.2830.0' });
});

test('castlabs, first launch: after a second the waiting window shows, then hides for the browser and closes once its window is there', async () => {
  const c = castlabs({ ms: 150 });
  const { drm, windows, BrowserWindow } = standIns({ components: c });
  let resolved = null;
  drm.whenReady().then((v) => { resolved = v; });
  await wait(20);
  assert.equal(windows.length, 0, 'not for a quick one');
  await wait(60);
  assert.equal(windows.length, 1);
  const [w] = windows;
  assert.equal(w.url, WAIT_URL);
  assert.equal(WAIT_URL, 'lumio://shell/drm-wait.html');
  assert.equal(w.shown, true);
  assert.deepEqual({ ...w.opts, webPreferences: undefined }, {
    width: 420, height: 180, show: false, frame: false, center: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'Getting protected content ready…', backgroundColor: '#070708', webPreferences: undefined,
  });
  assert.deepEqual(w.opts.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false }, 'no preload, no Node');
  assert.deepEqual(w.openHandler(), { action: 'deny' });
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  w.webContents.emit('will-navigate', nav, 'https://example.com');
  assert.ok(nav.prevented, 'it goes nowhere');
  assert.equal(resolved, null);
  await wait(160);
  assert.equal(resolved, true);
  assert.equal(w.hidden, true, 'out of the way at once');
  assert.equal(w.destroyed, false, 'still there, so Lumio is never without a window');
  new BrowserWindow({}); // the browser's first window
  await wait(5);
  assert.equal(w.destroyed, true);
  assert.equal(drm.status().state, 'ready');
});

test('Esc or Open now skips the wait; Widevine keeps installing and Settings shows when it’s ready', async () => {
  for (const how of ['esc', 'open now', 'closed']) {
    const c = castlabs({ ms: 200 });
    const { drm, windows } = standIns({ components: c });
    const ready = drm.whenReady();
    await wait(70);
    const [w] = windows;
    if (how === 'esc') {
      const typed = { preventDefault() { this.prevented = true; } };
      w.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'a' });
      w.webContents.emit('before-input-event', typed, { type: 'keyDown', key: 'Escape' });
      assert.ok(typed.prevented);
    } else if (how === 'open now') {
      w.webContents.emit('did-navigate-in-page', {}, 'lumio://shell/drm-wait.html#elsewhere');
      w.webContents.emit('did-navigate-in-page', {}, 'lumio://shell/drm-wait.html#skip');
    } else w.destroy(); // closed some other way
    assert.equal(await ready, false, how);
    assert.equal(drm.status().state, 'starting');
    await wait(260);
    assert.deepEqual(drm.status(), { available: true, state: 'ready', version: '4.10.2830.0' }, how);
  }
});

test('if Widevine fails or takes too long, Lumio opens anyway and says why in the log', async () => {
  const err = Object.assign(new Error('Component update failed'), { errors: [Object.assign(new Error('Widevine: download error (network)'), { detail: { id: 'x' } })] });
  const failing = standIns({ components: castlabs({ ms: 5, fail: err }) });
  assert.equal(await failing.drm.whenReady(), false);
  assert.deepEqual(failing.drm.status(), { available: true, state: 'failed', version: null });
  assert.deepEqual(failing.logs, [['error', '[lumio] Widevine couldn’t be set up: Widevine: download error (network)']]);

  const throwing = standIns({ components: { WIDEVINE_CDM_ID: 'w', whenReady() { throw new Error('not ready'); }, status() { throw new Error('nope'); } } });
  assert.equal(await throwing.drm.whenReady(), false);
  assert.deepEqual(throwing.drm.status(), { available: true, state: 'failed', version: null });

  const slow = standIns({ components: castlabs({ ms: 5000 }) });
  const t = Date.now();
  assert.equal(await slow.drm.whenReady(), false);
  assert.ok(Date.now() - t < 600, 'the time limit');
  assert.deepEqual(slow.logs, [['warn', '[lumio] Widevine isn’t ready after 0 s; opening Lumio anyway.']]);
  assert.equal(slow.windows[0].hidden, true);
});

test('e2e tests can stand in for castlabs’ API on stock Electron, only in test runs', async () => {
  const fake = standIns({ env: { LUMIO_TEST: '1', LUMIO_TEST_DRM_MS: '30' } });
  assert.deepEqual(fake.drm.status(), { available: true, state: 'starting', version: null });
  assert.equal(await fake.drm.whenReady(), true);
  assert.deepEqual(fake.drm.status(), { available: true, state: 'ready', version: '4.10.0.0' });
  assert.deepEqual(standIns({ env: { LUMIO_TEST_DRM_MS: '30' } }).drm.status(), { available: false }, 'never outside tests');
});

test('setup: Widevine starts getting ready with the app, alongside the rest of the start-up', async () => {
  const app = { readyFns: [], whenReady() { return { then: (fn) => { app.readyFns.push(fn); } }; } };
  const c = castlabs({ ms: 5 });
  const drm = setup(app, { electron: { app: new EventEmitter(), BrowserWindow: class {}, components: c }, slowMs: 40, maxMs: 400 });
  assert.deepEqual(c.asked, [], 'castlabs’ API only works once the app is ready');
  assert.equal(app.readyFns.length, 1);
  app.readyFns[0]();
  assert.equal(c.asked.length, 1, 'then at once');
  assert.equal(await drm.whenReady(), true, 'and the first window waits on the same promise');
  assert.equal(c.asked.length, 1);
});

test('main.js waits for Widevine before the first window, and only Settings asks about it', () => {
  const main = read('main/main.js');
  const ready = main.indexOf('app.whenReady().then(');
  const setupAt = main.indexOf("const drm = require('./drm').setup(app, { theme });");
  const waitAt = main.indexOf('await drm.whenReady();');
  const firstWindow = main.indexOf("createWindow({ tabs: [{ url: 'lumio://welcome/'");
  assert.ok(setupAt > 0 && setupAt < ready, 'set up before the app is ready');
  assert.ok(main.indexOf('registerUiProtocol(session.defaultSession);', ready) < waitAt, 'lumio://shell/ (the waiting window) is served by then');
  assert.ok(main.indexOf('await Promise.race([', ready) < waitAt, 'after the extensions, which load meanwhile');
  assert.ok(waitAt < main.indexOf('registerIpc();', ready) && waitAt < firstWindow);
  assert.equal(main.split('drm.whenReady()').length, 2, 'started by setup, awaited once');
  // Quitting from the waiting window must not open the browser in the middle of the quit.
  assert.match(main.slice(waitAt), /^await drm\.whenReady\(\);[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(quitting\) return;\n/);
  assert.match(main, /app\.on\('before-quit', \(\) => \{\n\s*saveSession\(\);\n\s*quitting = true;/);
  assert.match(main, /internalHandle\('page:protected-content', \['settings'\], \(\) => drm\.status\(\)\);/);
  assert.equal(resolveFile(new URL(WAIT_URL), new Set(['shell'])), path.join(ROOT, 'renderer', 'ui', 'drm-wait.html'));
});

// ---------------------------------------------------------------- pages (headless Chrome)
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const SETTINGS = {
  account: { signedIn: false }, profile: { name: 'Test', color: '#7ee2a8', theme: 'blue' }, startup: 'newtab', downloadDir: '/tmp/Downloads', askDownload: false,
  memorySaver: true, memorySaverMinutes: 60, offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google',
  engines: [{ id: 'google', name: 'Google' }], approvalMode: 'ask', showBookmarksBar: false, appearance: 'system',
  ai: { reasoning: 'medium', macAvailable: true }, version: '0.6.8', update: null, isDefault: false, importSources: [], sitePermissions: [],
};
const ANSWERS = {
  'page:settings': SETTINGS,
  'page:schedules': { signedIn: false, tasks: [] },
  'page:sync': { on: false, status: 'off', types: {}, requests: [] },
  'page:sync-devices': { ok: true, devices: [] },
  'page:site-tips': { sites: [] },
  'page:workflows': { workflows: [] },
  'page:mac-permissions': { accessibility: true, screen: true },
  'page:crash-reports': { on: false, active: false },
};

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // /ui/… is the browser's own UI (lumio://shell/), everything else Lumio's pages.
    const file = url.pathname.startsWith('/ui/')
      ? resolveFile(new URL(`lumio://shell${url.pathname.slice(3)}`), new Set(['shell']))
      : resolveFile(new URL(`lumio://settings${url.pathname}`), PAGE_HOSTS);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// An element's text color and what shows behind it, see-through layers
// painted over each other, as [r, g, b].
const colorsOf = (page, sel) => page.$eval(sel, (n) => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const paint = (...colors) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const c of ['#fff', ...colors]) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const layers = [];
  for (let el = n; el; el = el.parentElement) layers.unshift(getComputedStyle(el).backgroundColor);
  const bg = paint(...layers);
  return [paint(`rgb(${bg})`, getComputedStyle(n).color), bg];
});

// html: changes settings.html before it loads (another layout of Site settings).
async function openSettings({ colorScheme = 'light', protectedContent, html }) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  if (html) await page.route(/\/settings\.html$/, async (r) => r.fulfill({ response: await r.fetch(), body: html(read('renderer/pages/settings.html')) }));
  await page.addInitScript(({ answers, pc }) => {
    window.__calls = [];
    window.__pc = pc; // what main/drm.js says, changeable by the test
    window.lumioPage = {
      invoke: async (channel, ...args) => {
        window.__calls.push(channel);
        if (channel === 'page:protected-content') {
          if (window.__pc === 'missing') throw new Error('No handler registered');
          return structuredClone(window.__pc);
        }
        return structuredClone(answers[channel] ?? null);
      },
      on: () => {},
    };
  }, { answers: ANSWERS, pc: protectedContent });
  await page.goto(`${base}/settings.html#privacy`);
  await page.waitForFunction(() => window.__calls.includes('page:protected-content'));
  await page.waitForTimeout(150);
  return { page, errors };
}

for (const scheme of ['light', 'dark']) {
  test(`Settings › Site settings in ${scheme}: a DRM build says protected content plays, and Widevine is ready`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    const { page, errors } = await openSettings({ colorScheme: scheme, protectedContent: { available: true, state: 'ready', version: '4.10.2830.0' } });
    assert.equal(await page.$eval('#protected-content', (b) => b.closest('section').id), 'privacy');
    assert.equal(await page.$eval('#protected-content', (b) => b.previousElementSibling.id), 'site-list', 'under the site list');
    const text = await page.$eval('#protected-content', (b) => b.innerText);
    assert.match(text, /^PROTECTED CONTENT IDS\s+Sites can play protected content\s+Sites like Netflix, Spotify and Disney\+ can play protected videos and music\. Lumio gets Google’s Widevine module for this, the same one Chrome uses\.\s+Ready · Widevine 4\.10\.2830\.0$/);
    assert.equal(await page.$eval('#pc-state', (s) => s.getAttribute('role')), 'status');
    assert.equal(await page.$eval('#protected-content .card', (c) => `${c.getAttribute('aria-labelledby')}|${c.getAttribute('aria-describedby')}`), 'pc-title|pc-desc pc-state');
    for (const sel of ['#pc-title', '#pc-desc', '#pc-state', '#protected']) {
      const [fg, bg] = await colorsOf(page, sel);
      if (sel === '#pc-title') assert.ok(scheme === 'light' ? luminance(bg) > 0.7 : luminance(bg) < 0.05, `the card is ${scheme}`);
      assert.ok(contrast(fg, bg) >= 4.5, `${sel} reads at ${contrast(fg, bg).toFixed(2)}:1`);
    }
    if (process.env.LUMIO_SHOTS) await (await page.$('#protected-content')).screenshot({ path: path.join(process.env.LUMIO_SHOTS, `drm-settings-${scheme}.png`) });
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('Settings: while Widevine downloads it says so, then updates by itself; a failure says what happens next', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openSettings({ protectedContent: { available: true, state: 'starting', version: null } });
  assert.equal(await page.$eval('#pc-state', (s) => s.textContent), 'Getting ready… Lumio is downloading Google’s Widevine module.');
  await page.evaluate(() => { window.__pc = { available: true, state: 'ready', version: null }; });
  await page.waitForFunction(() => document.getElementById('pc-state').textContent === 'Ready.', null, { timeout: 5000 });
  assert.equal(await page.$$eval('#protected-content h3', (h) => h.length), 1, 'drawn once');
  await page.close();
  const failed = await openSettings({ protectedContent: { available: true, state: 'failed', version: null } });
  assert.equal(await failed.page.$eval('#pc-state', (s) => s.textContent), 'Couldn’t get it ready. Lumio tries again the next time it opens.');
  await failed.page.close();
  assert.deepEqual([...errors, ...failed.errors], []);
});

test('Settings on a normal build (or an older browser): no protected content row, nothing else changes', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  for (const pc of [{ available: false }, 'missing']) {
    const { page, errors } = await openSettings({ protectedContent: pc });
    assert.equal(await page.$('#protected-content'), null);
    assert.deepEqual(await page.$$eval('#privacy > *', (els) => els.slice(-2).map((e) => e.id)), ['sites', 'site-list'], 'Site settings stay last');
    await page.close();
    assert.deepEqual(errors, []);
  }
});

test('Settings with Site settings on a page of its own: protected content goes under its card', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  // Site settings as a link to its own page, the way the privacy work lays it out.
  const html = (src) => src.replace('<h3 id="sites">Site settings</h3>\n        <div class="card" id="site-list"></div>',
    '<div class="card"><a class="row sub-link" href="/content" id="sites"><div class="grow"><div class="title">Site settings</div></div></a></div>');
  assert.notEqual(html(read('renderer/pages/settings.html')), read('renderer/pages/settings.html'));
  const { page, errors } = await openSettings({ protectedContent: { available: true, state: 'ready', version: null }, html });
  assert.equal(await page.$('#site-list'), null);
  assert.equal(await page.$eval('#protected-content', (b) => b.previousElementSibling.contains(document.getElementById('sites'))), true);
  assert.equal(await page.$eval('#pc-state', (s) => s.textContent), 'Ready.');
  await page.close();
  // settings.js expects today's #site-list; the page that changes it changes settings.js too.
  assert.deepEqual(errors.filter((e) => e.includes('protected-content')), []);
});

for (const scheme of ['light', 'dark']) {
  test(`the waiting window in ${scheme}: says what’s happening, fits, and Open now has focus for Enter`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    const page = await browser.newPage({ viewport: { width: 420, height: 180 }, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`); });
    await page.goto(`${base}/ui/drm-wait.html`);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.title(), 'Getting protected content ready…');
    assert.match(await page.$eval('main', (m) => m.innerText), /^Getting protected content ready…\s+Lumio is setting up playback for sites like Netflix and Spotify\. It only takes a moment the first time\.\s+Open now$/);
    assert.equal(await page.$eval('main', (m) => `${m.getAttribute('role')}|${m.getAttribute('aria-labelledby')}|${m.getAttribute('aria-describedby')}`), 'null|drm-title|drm-desc');
    assert.equal(await page.$eval('.text', (t) => t.getAttribute('role')), 'status', 'the status doesn’t include the button');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Open now', 'focused, so Enter opens Lumio');
    assert.equal(await page.evaluate(() => document.querySelectorAll('script').length), 0, 'no script: the browser does the rest');
    // Everything inside the window, nothing cut off.
    const fits = await page.evaluate(() => [...document.querySelectorAll('h1, p, .btn, .spinner')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1;
    }) && document.documentElement.scrollHeight <= innerHeight);
    assert.ok(fits, 'fits in 420 × 180');
    const [bodyFg, bodyBg] = await colorsOf(page, 'h1');
    assert.ok(scheme === 'light' ? luminance(bodyBg) > 0.7 : luminance(bodyBg) < 0.05, `the window is ${scheme}`);
    for (const sel of ['h1', 'p', '.btn']) {
      const [fg, bg] = await colorsOf(page, sel);
      assert.ok(contrast(fg, bg) >= 4.5, `${sel} reads at ${contrast(fg, bg).toFixed(2)}:1`);
    }
    assert.ok(contrast(bodyFg, bodyBg) >= 4.5);
    // Keyboard: the focus ring shows, and Enter goes to #skip, which main/drm.js watches for.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval('.btn', (b) => getComputedStyle(b).outlineStyle), 'solid');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#skip');
    assert.notEqual(await page.$eval('.spinner', (s) => getComputedStyle(s).animationName), 'none', 'it spins');
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `drm-wait-${scheme}.png`) });
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('the waiting window keeps still for people who turn off motion', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 420, height: 180 }, reducedMotion: 'reduce' });
  await page.goto(`${base}/ui/drm-wait.html`);
  assert.equal(await page.$eval('.spinner', (s) => getComputedStyle(s).animationName), 'none');
  await page.close();
});
