// End-to-end: a newer release shows the blue Update button; clicking it
// downloads the DMG, verifies it and swaps it in. It installs over a stand-in
// "Lumio Browser.app" in a temp folder (never the real one) and doesn't quit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from '../../scripts/launch.mjs';

const mac = process.platform === 'darwin';
let L;
let server;
let tmp;
let target;
let requests = 0;

const until = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
};

// A minimal signed app bundle, as the release would contain.
function fakeApp(dir, version) {
  const app = path.join(dir, 'Lumio Browser.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>online.lumio-usa.browser</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Lumio Browser</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  const exe = path.join(app, 'Contents', 'MacOS', 'Lumio Browser');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(exe, 0o755);
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

before(async () => {
  if (!mac) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-update-e2e-'));
  // The release: version 9.9.9 in a real DMG.
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  fakeApp(src, '9.9.9');
  const dmg = path.join(tmp, 'release.dmg');
  execFileSync('hdiutil', ['create', '-volname', 'Lumio Browser', '-srcfolder', src, '-ov', '-format', 'UDZO', dmg], { stdio: 'ignore' });
  const bytes = fs.readFileSync(dmg);
  const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  // The copy being updated, with a marker so we can tell it was replaced.
  const installed = path.join(tmp, 'Applications');
  fs.mkdirSync(installed);
  target = fakeApp(installed, '0.0.1');
  fs.writeFileSync(path.join(target, 'Contents', 'old-marker'), 'old');

  const name = process.arch === 'arm64' ? 'Lumio-Browser-mac-apple-silicon.dmg' : 'Lumio-Browser-mac-intel.dmg';
  server = http.createServer((q, r) => {
    requests++;
    if (q.url === '/latest') {
      const base = `http://127.0.0.1:${server.address().port}`;
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ tag_name: 'v9.9.9', draft: false, prerelease: false, html_url: base + '/notes', body: "## What's new\n\n- **Passkeys** in every tab\n- Faster tabs\n\n<!-- lumio:critical -->\n\n## Install\n\n- Mac: dmg", assets: [{ name, size: bytes.length, digest, browser_download_url: base + '/' + name }] }));
      return;
    }
    if (q.url === '/' + name) { r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }); r.end(bytes); return; }
    r.writeHead(404); r.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  L = await launch({ env: { LUMIO_UPDATE_API: `http://127.0.0.1:${server.address().port}/latest`, LUMIO_UPDATE_TARGET: target } });
  await until(() => L.main(() => !!global.lumio?.tabs?.active));
});

after(async () => {
  await L?.close();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a newer release shows the Update button next to the profile picture', { skip: !mac }, async () => {
  assert.ok(await until(() => L.shell(`!document.getElementById('update-btn').hidden`)), 'button shown');
  const info = await L.shell(`(() => { const b = document.getElementById('update-btn'); const a = document.getElementById('account-btn'); return { label: b.textContent.trim(), next: b.nextElementSibling === a, bg: getComputedStyle(b).backgroundColor, title: b.title } })()`);
  assert.equal(info.label, 'Update');
  assert.ok(info.next, 'right before the avatar');
  assert.equal(info.bg, 'rgb(47, 124, 246)', 'blue');
  assert.match(info.title, /9\.9\.9 is available/);
  if (process.env.LUMIO_SHOTS) { await new Promise((r) => setTimeout(r, 800)); fs.mkdirSync(process.env.LUMIO_SHOTS, { recursive: true }); await L.shot(path.join(process.env.LUMIO_SHOTS, '32-update-button.png')); }
});

test("a new version shows its What's new card by itself, once (urgent: every launch)", { skip: !mac }, async () => {
  assert.ok(await until(async () => (await L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current))) === 'update', 10_000), 'card opened');
  const card = await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText'));
  assert.match(card, /Important update[\s\S]*Lumio Browser 9\.9\.9 is here[\s\S]*Passkeys in every tab[\s\S]*Faster tabs[\s\S]*Update now/);
  assert.doesNotMatch(card, /Install|dmg/, 'no install section');
  const state = await L.main(() => global.lumio.updater.state);
  assert.equal(state.critical, true);
  if (process.env.LUMIO_SHOTS) { await new Promise((r) => setTimeout(r, 500)); await L.shot(path.join(process.env.LUMIO_SHOTS, '33-update-card.png')); }
  // Later closes it; the Update button opens it again.
  await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector('[data-up="later"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`));
  assert.ok(await until(async () => (await L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current))) !== 'update'));
});

test('Update now (from the card) downloads, verifies and installs the new version', { skip: !mac }, async () => {
  await L.shell(`document.getElementById('update-btn').click(); true`);
  assert.ok(await until(async () => (await L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current))) === 'update'));
  await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector('[data-up="now"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`));
  assert.ok(await until(() => L.main(() => global.lumio.updater?.state.status === 'installing'), 30_000), 'installing');
  assert.equal(await L.shell(`document.querySelector('#update-btn .label').textContent`), 'Restarting…');
  const plist = path.join(target, 'Contents', 'Info.plist');
  assert.ok(await until(async () => fs.existsSync(plist) && fs.readFileSync(plist, 'utf8').includes('9.9.9'), 40_000), 'new version swapped in');
  assert.equal(fs.existsSync(path.join(target, 'Contents', 'old-marker')), false, 'old copy removed');
  // The old copy is deleted right after the swap (rm -rf can take a moment).
  await until(async () => fs.readdirSync(path.dirname(target)).length === 1, 20_000);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['Lumio Browser.app'], 'no leftovers next to the app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', target]);
});
