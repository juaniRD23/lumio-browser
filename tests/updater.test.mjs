import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Updater, compareVersions, assetName, releaseNotes } = require('../main/updater.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const INSTALLER = Buffer.from('pretend this is a DMG '.repeat(4000));

function release({ tag = 'v0.3.0', digest = `sha256:${sha(INSTALLER)}`, size = INSTALLER.length, draft = false, name = 'Lumio-Browser-mac-apple-silicon.dmg' } = {}) {
  return {
    tag_name: tag, draft, prerelease: false, html_url: 'https://github.com/juaniRD23/lumio-browser/releases/tag/' + tag,
    assets: [{ name, size, digest, browser_download_url: 'https://example.test/' + name }],
  };
}

// A fetch that serves the release JSON and the installer bytes in small chunks.
function fakeFetch(rel, body = INSTALLER) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('api')) return new Response(JSON.stringify(rel), { status: 200 });
    const stream = new ReadableStream({
      start(c) { for (let i = 0; i < body.length; i += 7000) c.enqueue(body.subarray(i, i + 7000)); c.close(); },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function make(opts = {}) {
  const states = [];
  const u = new Updater({
    currentVersion: '0.2.1', platform: 'darwin', arch: 'arm64', api: 'https://api.test/latest',
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-upd-')), onChange: (s) => states.push(s), ...opts,
  });
  return { u, states };
}

test('versions compare numerically, pre-releases first', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('0.2.1', '0.2.2'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('each computer gets its own installer', () => {
  assert.equal(assetName('darwin', 'arm64'), 'Lumio-Browser-mac-apple-silicon.dmg');
  assert.equal(assetName('darwin', 'x64'), 'Lumio-Browser-mac-intel.dmg');
  assert.equal(assetName('win32', 'x64'), 'Lumio-Browser-windows-x64.zip');
  assert.equal(assetName('linux', 'x64'), null);
});

test('check: newer release -> available; same, draft or missing installer -> current', async () => {
  let { u } = make({ fetchImpl: fakeFetch(release()) });
  assert.equal((await u.check()).status, 'available');
  assert.equal(u.state.latest, '0.3.0');
  ({ u } = make({ fetchImpl: fakeFetch(release({ tag: 'v0.2.1' })) }));
  assert.equal((await u.check()).status, 'current');
  ({ u } = make({ fetchImpl: fakeFetch(release({ draft: true })) }));
  assert.equal((await u.check()).status, 'current');
  ({ u } = make({ fetchImpl: fakeFetch(release({ name: 'something-else.dmg' })) }));
  assert.equal((await u.check()).status, 'current');
});

test('check: errors stay quiet unless the person asked', async () => {
  const down = async () => new Response('nope', { status: 503 });
  const { u } = make({ fetchImpl: down });
  assert.equal((await u.check()).error, null);
  assert.match((await u.check({ manual: true })).error, /503/);
});

test('download: streams with progress and verifies size and SHA-256', async () => {
  const { u, states } = make({ fetchImpl: fakeFetch(release()) });
  await u.check();
  const file = await u.download();
  assert.equal(u.state.status, 'ready');
  assert.deepEqual(fs.readFileSync(file), INSTALLER);
  assert.ok(states.some((s) => s.status === 'downloading' && s.progress > 0 && s.progress < 100), 'reports progress');
  assert.equal(await u.download(), file, 'downloads once');
});

test('download: a tampered or truncated installer is thrown away', async () => {
  const bad = Buffer.from(INSTALLER);
  bad[100] ^= 1;
  let { u } = make({ fetchImpl: fakeFetch(release(), bad) });
  await u.check();
  await assert.rejects(u.download(), /fingerprint/);
  assert.equal(u.state.status, 'available');
  assert.match(u.state.error, /fingerprint/);
  assert.deepEqual(fs.readdirSync(u.workDir), [], 'nothing left on disk');

  ({ u } = make({ fetchImpl: fakeFetch(release({ digest: null }), INSTALLER.subarray(0, 1000)) }));
  await u.check();
  await assert.rejects(u.download(), /incomplete/);
});

test("install: if the app's folder isn't writable, the installer is opened for the person", { skip: process.platform !== 'darwin' && 'Mac only (disk images)' }, async () => {
  const opened = [];
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-ro-')), 'Lumio Browser.app');
  fs.mkdirSync(target);
  fs.chmodSync(path.dirname(target), 0o555);
  try {
    const { u } = make({ fetchImpl: fakeFetch(release()), installTarget: target, openPath: (f) => opened.push(f), quit: () => { throw new Error('should not quit'); } });
    await u.check();
    const s = await u.install();
    assert.equal(s.status, 'manual');
    assert.equal(opened.length, 1);
    assert.ok(opened[0].endsWith('.dmg'));
  } finally {
    fs.chmodSync(path.dirname(target), 0o755);
  }
});

test('install: asks before setting up the swap; staying (Cancel on "Leave site?" or downloads) leaves nothing waiting to replace the app', async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-rw-')), 'Lumio Browser.app');
  fs.mkdirSync(target);
  let asked = 0;
  const { u } = make({
    fetchImpl: fakeFetch(release()), installTarget: target,
    confirmQuit: async () => { asked++; return false; },
    quit: () => { throw new Error('should not quit'); },
  });
  await u.check();
  const s = await u.install();
  assert.equal(asked, 1);
  assert.equal(s.status, 'ready', 'ready to try again later');
  assert.deepEqual(fs.readdirSync(u.workDir).filter((f) => f.startsWith('stage-')), [], 'nothing staged');
});

test('install: when installing fails after you agreed, the pages that went to sleep come back', async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-rw-')), 'Lumio Browser.app');
  fs.mkdirSync(target);
  let stayed = 0;
  const { u } = make({
    platform: 'linux', fetchImpl: fakeFetch(release()), installTarget: target, // no installer here: it fails
    confirmQuit: async () => true, stayed: () => { stayed++; },
    quit: () => { throw new Error('should not quit'); },
  });
  u.platform = 'darwin';
  await u.check();
  u.platform = 'linux';
  await assert.rejects(u.install());
  assert.equal(stayed, 1);
  assert.equal(u.state.status, 'ready');
});

test("release notes: What's new without the install section; the urgent marker", () => {
  const body = "## What's new\n\n- Passkeys\n- Faster tabs\n\n<!-- lumio:critical -->\n\n## Install\n\n- **Mac:** dmg";
  assert.deepEqual(releaseNotes(body), { notes: '- Passkeys\n- Faster tabs', critical: true });
  assert.deepEqual(releaseNotes('- Just a fix'), { notes: '- Just a fix', critical: false });
  assert.deepEqual(releaseNotes(null), { notes: '', critical: false });
});

test('Windows: copies installed with the setup update with the setup; zip copies with the zip; the Store version never checks', async () => {
  const { assetName: name, installedBySetup: bySetup, Updater: U } = require('../main/updater.js');
  assert.equal(name('win32', 'x64'), 'Lumio-Browser-windows-x64.zip');
  assert.equal(name('win32', 'x64', { windowsSetup: true }), 'Lumio-Browser-Setup-windows-x64.exe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-setup-'));
  const exe = path.join(dir, 'Lumio Browser.exe');
  assert.equal(bySetup(exe), false);
  fs.writeFileSync(path.join(dir, 'Uninstall Lumio Browser.exe'), '');
  assert.equal(bySetup(exe), true);
  let asked = 0;
  const store = new U({ currentVersion: '1.0.0', platform: 'win32', arch: 'x64', exePath: exe, store: true, fetchImpl: async () => { asked++; throw new Error('no'); } });
  assert.equal(store.state.status, 'store');
  await store.check({ manual: true });
  assert.equal(asked, 0, 'the Microsoft Store updates it');
  assert.equal(new U({ currentVersion: '1.0.0', platform: 'win32', arch: 'x64', exePath: exe }).windowsSetup, true);
});

// ---------------------------------------------------------------- Lumio Beta
test('Lumio Beta: betas sort by number; its own installers; it follows the newest beta only', async () => {
  assert.equal(compareVersions('0.6.7-beta.10', '0.6.7-beta.9'), 1, 'beta.10 after beta.9');
  assert.equal(compareVersions('0.6.7', '0.6.7-beta.3'), 1, 'the release after its betas');
  assert.equal(compareVersions('0.6.7-beta.1', '0.6.6'), 1);
  assert.equal(assetName('darwin', 'arm64', { prefix: 'Lumio-Beta' }), 'Lumio-Beta-mac-apple-silicon.dmg');
  const beta = (tag, prerelease = true, name = 'Lumio-Beta-mac-apple-silicon.dmg') => ({ ...release({ tag, name }), prerelease });
  const list = [beta('v0.6.7-beta.2'), beta('v0.6.7-beta.10'), beta('v0.6.8', false, 'Lumio-Browser-mac-apple-silicon.dmg'), beta('v0.6.7-beta.11', true, 'Lumio-Browser-mac-apple-silicon.dmg')];
  const { u } = make({ currentVersion: '0.6.7-beta.2', beta: true, assetPrefix: 'Lumio-Beta', appName: 'Lumio Beta', bundleId: 'online.lumio-usa.browser.beta', fetchImpl: fakeFetch(list) });
  assert.equal((await u.check()).status, 'available');
  assert.equal(u.state.latest, '0.6.7-beta.10', 'the newest beta that has a Lumio Beta installer');
  assert.equal(u.release.name, 'Lumio-Beta-mac-apple-silicon.dmg');
  // The normal app ignores betas.
  const normal = make({ currentVersion: '0.6.6', fetchImpl: fakeFetch(beta('v0.6.7-beta.10', true, 'Lumio-Browser-mac-apple-silicon.dmg')) }).u;
  assert.equal((await normal.check()).status, 'current');
  // Nothing newer: up to date.
  const done = make({ currentVersion: '0.6.7-beta.10', beta: true, assetPrefix: 'Lumio-Beta', fetchImpl: fakeFetch(list) }).u;
  assert.equal((await done.check()).status, 'current');
});

test('Lumio Beta: the next beta version', async () => {
  const { nextBeta } = await import('../scripts/beta.mjs');
  assert.equal(nextBeta('0.6.6', []), '0.6.7-beta.1');
  assert.equal(nextBeta('0.6.6', ['v0.6.7-beta.1', 'v0.6.7-beta.2', 'v0.6.5-beta.9']), '0.6.7-beta.3');
});
