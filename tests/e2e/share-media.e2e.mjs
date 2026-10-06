// End-to-end tests for Share, websites' Share buttons, media controls,
// screenshots, installed apps and the page tools' right-click items, in the
// real app against a stand-in Lumio server (tests/mock-lumio.mjs).
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from '../../scripts/launch.mjs';
import { startMockLumio } from '../mock-lumio.mjs';

const FIX = path.join(root, 'tests', 'fixtures');
const SHOTS = process.env.LUMIO_SHOTS;
const MAC = process.platform === 'darwin';
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let L;
let site;
let siteUrl;
let lumio;

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await L.wait(200);
  }
};
const go = async (url) => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), url);
  return until(() => L.main((_e, u) => global.lumio.tabs.wc().getURL() === u && !global.lumio.tabs.wc().isLoading(), url));
};
// Runs JS in the window's dropdown view (the popovers).
const overlay = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
const overlayKind = () => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current));
// Runs JS in the page as if the person clicked (user activation).
const click = (code) => L.main((_e, c) => global.lumio.tabs.wc().executeJavaScript(c, true), code);

before(async () => {
  site = http.createServer((q, r) => {
    const f = path.join(FIX, q.url.split('?')[0]);
    if (!f.startsWith(FIX) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    r.end(fs.readFileSync(f));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  lumio = await startMockLumio({ plan: 'free' });
  L = await launch({ env: { LUMIO_ACCOUNT_BASE: lumio.base, LUMIO_AI_BASE: lumio.base } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(800);
});

after(async () => {
  await L?.close();
  site?.close();
  lumio?.server.close();
});

test('Share in the address bar: Copy link and a QR code made on this computer', async () => {
  const url = `${siteUrl}/media-share.html`;
  assert.ok(await go(url));
  assert.ok(await until(() => L.shell(`!document.getElementById('share-btn').hidden`)), 'the button shows on a web page');
  await L.shell(`document.getElementById('share-btn').click(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'share' && overlay(`!!document.querySelector('.sh-row[data-act="copy"]')`)));
  assert.equal(await overlay(`document.querySelector('.sh-title').textContent`), 'Fixture Radio');
  assert.equal(await overlay(`!!document.querySelector('[data-view="devices"]')`), false, 'Send to your devices needs Lumio Sync');
  assert.equal(await overlay(`!!document.querySelector('[data-act="install"]') && !!document.querySelector('[data-act="screenshot"]')`), true);
  await shot('share-popover');
  await overlay(`document.querySelector('[data-act="copy"]').click(); true`);
  assert.ok(await until(async () => (await L.main((e) => e.clipboard.readText())) === url));
  assert.ok(await until(async () => (await overlayKind()) === null), 'it closes');

  // The QR code view, from the ⋮ menu's Save and share.
  await L.main(() => global.lumio.cmd.share('qr'));
  assert.ok(await until(() => overlay(`(document.querySelector('canvas.qr')?.width || 0) > 100`)));
  assert.equal(await overlay(`document.querySelector('.qr-err').hidden`), true);
  await shot('share-qr');
  await overlay(`document.getElementById('card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  assert.ok(await until(() => overlay(`!!document.querySelector('.sh-row[data-act="copy"]')`)), 'Esc goes back to the main list');
  await overlay(`document.querySelector('[data-act="close"]').click(); true`);
  assert.ok(await until(async () => (await overlayKind()) === null));
});

test('a website’s Share button opens Lumio’s popover, and the page learns it was shared', async (t) => {
  assert.ok(await go(`${siteUrl}/media-share.html`));
  await L.main(() => { global.lumio.current.focus(); });
  if (!(await until(() => L.main(() => global.lumio.win.isFocused()), 5000))) { t.skip('the window can’t be brought to the front here'); return; }
  assert.equal(await L.page(`typeof navigator.share`), 'function');
  assert.equal(await L.page(`navigator.canShare({ files: [new File(['x'], 'x.txt')] })`), false, 'files can’t be shared');
  await click(`document.getElementById('share').click(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'share' && overlay(`!!document.querySelector('.sh-web')`)));
  assert.match(await overlay(`document.querySelector('.sh-web').textContent`), /127\.0\.0\.1.* wants to share/);
  assert.equal(await overlay(`!!document.querySelector('[data-act="install"]')`), false, 'no page tools for what a site asks to share');
  await overlay(`document.querySelector('[data-act="copy"]').click(); true`);
  assert.ok(await until(async () => (await L.page(`window.__log.join()`)) === 'shared'));
  assert.equal(await L.main((e) => e.clipboard.readText()), `${siteUrl}/shared`);
});

test('media controls: the toolbar button, what’s playing, next track, pause and Picture in picture', async () => {
  assert.ok(await go(`${siteUrl}/media-share.html`));
  await click(`window.start().then(() => true)`);
  assert.ok(await until(() => L.page(`!document.getElementById('v').paused`)));
  // GitHub's Macs have no speakers: say the tab made sound, like Chromium does.
  await L.main(() => global.lumio.tabs.wc().emit('audio-state-changed', { audible: true }));
  assert.ok(await until(() => L.shell(`!document.getElementById('media-btn').hidden`)), 'the button shows once a tab makes sound');
  assert.ok(await until(() => L.main(() => (global.lumio.tabs.active.mediaActions || []).includes('nexttrack'))), 'the site’s handlers are known');
  await L.shell(`document.getElementById('media-btn').click(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'media' && overlay(`document.querySelector('.mh-meta b')?.textContent === 'Fixture Song'`)));
  assert.match(await overlay(`document.querySelector('.mh-meta span').textContent`), /The Testers/);
  assert.equal(await overlay(`document.querySelector('[data-act="prev"]').disabled`), false);
  await shot('media-popover');
  // Next track runs the site's own handler.
  await overlay(`document.querySelector('[data-act="next"]').click(); true`);
  assert.ok(await until(async () => (await L.page(`window.__log.join()`)).includes('next')));
  // Picture in picture, then back.
  assert.ok(await until(() => overlay(`!!document.querySelector('[data-act="pip"]')`)));
  await overlay(`document.querySelector('[data-act="pip"]').click(); true`);
  assert.ok(await until(() => L.page(`document.pictureInPictureElement?.id === 'v'`)), 'the video goes into Picture in picture');
  await L.page(`document.exitPictureInPicture().then(() => true)`);
  // Pause pauses the player itself (the site has no pause handler).
  assert.ok(await until(() => overlay(`!!document.querySelector('.mh-play[data-act="pause"]')`)));
  await overlay(`document.querySelector('.mh-play').click(); true`);
  assert.ok(await until(() => L.page(`document.getElementById('v').paused`)));
  await overlay(`document.getElementById('card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  assert.ok(await until(async () => (await overlayKind()) === null), 'Esc closes it');
  // Going to another page clears it.
  assert.ok(await go(`${siteUrl}/media-share.html?again`));
  assert.ok(await until(() => L.shell(`document.getElementById('media-btn').hidden`)));
});

test('the right-click menu: a video’s Loop, Show controls and Picture in picture; link text, link to highlight and QR codes', async () => {
  assert.ok(await go(`${siteUrl}/media-share.html`));
  // The page tools' part of the menu for the video, as main/tabs.js asks for it.
  const label = (section, params) => L.main((_e, a) => {
    const w = global.lumio.current;
    const tab = w.tabs.active;
    const p = { ...a.params, frame: tab.view.webContents.mainFrame };
    return global.lumio.pageTools.pageMenu.items(w, a.section, tab, p).map((i) => i.label);
  }, { section, params });
  const run = (section, params, name) => L.main((_e, a) => {
    const w = global.lumio.current;
    const tab = w.tabs.active;
    const p = { ...a.params, frame: tab.view.webContents.mainFrame };
    global.lumio.pageTools.pageMenu.items(w, a.section, tab, p).find((i) => i.label === a.name).click();
    return true;
  }, { section, params, name });
  const box = await L.page(`(() => { const r = document.getElementById('v').getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.y + 20) }; })()`);
  const video = { mediaType: 'video', ...box, srcURL: '', mediaFlags: { isPaused: true, canLoop: true, canToggleControls: true, canShowPictureInPicture: true } };
  assert.deepEqual(await label('media', video), ['Play', 'Mute', 'Loop', 'Show Controls', 'Picture in Picture']);
  await run('media', video, 'Loop');
  assert.ok(await until(() => L.page(`document.getElementById('v').loop`)));
  await run('media', video, 'Show Controls');
  assert.ok(await until(() => L.page(`document.getElementById('v').controls`)));
  await click(`window.start().then(() => true)`);
  await run('media', video, 'Picture in Picture');
  assert.ok(await until(() => L.page(`document.pictureInPictureElement?.id === 'v'`)));
  await L.page(`document.exitPictureInPicture().then(() => true)`);

  // A link: its text, and a QR code for it.
  const link = { linkURL: `${siteUrl}/media-share.html?more`, linkText: 'Read more stories' };
  assert.deepEqual(await label('link', link), ['Copy Link Text', 'Create QR Code for This Link']);
  await run('link', link, 'Copy Link Text');
  assert.equal(await L.main((e) => e.clipboard.readText()), 'Read more stories');
  await run('link', link, 'Create QR Code for This Link');
  assert.ok(await until(() => overlay(`document.querySelector('.qr-url')?.textContent === ${JSON.stringify(`${siteUrl.replace('http://', '')}/media-share.html?more`)}`)));
  await overlay(`document.querySelector('[data-act="close"]').click(); true`);

  // Selected text: a link that scrolls to it.
  await L.page(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('quote')); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`);
  const sel = { selectionText: 'The quiet harbor wakes before the gulls do.' };
  assert.ok((await label('selection', sel)).includes('Copy Link to Highlight'));
  await run('selection', sel, 'Copy Link to Highlight');
  assert.ok(await until(async () => (await L.main((e) => e.clipboard.readText())).includes('#:~:text=')));
  assert.equal(await L.main((e) => e.clipboard.readText()), `${siteUrl}/media-share.html#:~:text=The%20quiet%20harbor%20wakes%20before%20the%20gulls%20do.`);
  // In a text field: Emoji & Symbols (and on the Mac, Look Up and Speech with a selection).
  const fieldItems = await label('editable', { isEditable: true, selectionText: 'harbor' });
  if (await L.main((e) => e.app.isEmojiPanelSupported())) assert.ok(fieldItems.includes(MAC ? 'Emoji & Symbols' : 'Emoji'));
  if (MAC) assert.ok(fieldItems.includes('Look Up “harbor”') && fieldItems.includes('Speech'));
});

test('Screenshot: the visible area and the whole page, copied to the clipboard', async () => {
  assert.ok(await go(`${siteUrl}/media-share.html`));
  const view = (code) => L.main((_e, c) => {
    const s = global.lumio.pageTools.screenshots.sessions.get(global.lumio.current);
    return s ? s.view.webContents.executeJavaScript(c) : null;
  }, code);
  await L.main((e) => e.clipboard.clear());
  await L.main(() => global.lumio.cmd.share('screenshot'));
  assert.ok(await until(() => view(`!document.getElementById('pick').hidden && document.getElementById('frozen').naturalWidth > 0`)));
  await shot('screenshot-pick');
  await view(`document.querySelector('[data-act="visible"]').click(); true`);
  assert.ok(await until(() => view(`document.getElementById('status').textContent.startsWith('Copied')`)));
  const visible = await L.main((e) => e.clipboard.readImage().getSize());
  const bounds = await L.main(() => global.lumio.tabs.active.view.getBounds());
  assert.ok(visible.width >= bounds.width && visible.height >= bounds.height - 2, `the visible area (${visible.width}×${visible.height})`);
  await shot('screenshot-edit');
  await view(`document.querySelector('#edit [data-act="close"]').click(); true`);
  assert.ok(await until(() => L.main(() => !global.lumio.pageTools.screenshots.sessions.has(global.lumio.current))), 'Done closes it');

  // The whole page is taller than the window.
  await L.main(() => global.lumio.cmd.share('screenshot'));
  assert.ok(await until(() => view(`!document.getElementById('pick').hidden && document.getElementById('frozen').naturalWidth > 0`)));
  await view(`document.querySelector('[data-act="full"]').click(); true`);
  assert.ok(await until(() => view(`!document.getElementById('edit').hidden && document.getElementById('status').textContent.startsWith('Copied')`), 20_000));
  const full = await L.main((e) => e.clipboard.readImage().getSize());
  assert.ok(full.height > visible.height * 1.5, `the whole page (${full.width}×${full.height})`);
  // Switching tabs closes it.
  await L.main(() => global.lumio.tabs.create('about:blank'));
  assert.ok(await until(() => L.main(() => !global.lumio.pageTools.screenshots.sessions.has(global.lumio.current))));
  await L.main(() => global.lumio.tabs.close(global.lumio.tabs.activeId));
});

test('Install page as app: the dialog, its own window and title bar, lumio://apps, and its launcher', async () => {
  assert.ok(await go(`${siteUrl}/media-share.html`));
  await L.main(() => global.lumio.cmd.share('install'));
  assert.ok(await until(async () => (await overlayKind()) === 'install' && overlay(`document.getElementById('ins-name')?.value === 'Fixture Radio App'`)), 'the name comes from the manifest');
  assert.equal(await overlay(`document.querySelector('img.ins-icon')?.src.startsWith('data:image/png')`), true, 'with the manifest’s icon');
  await shot('install-dialog');
  await overlay(`document.querySelector('[data-act="install"]').click(); true`);
  const apps = () => L.main(() => global.lumio.pageTools.apps.list().map((a) => ({ id: a.id, name: a.name, url: a.url, launchers: a.launchers, profile: a.profile || null })));
  assert.ok(await until(async () => (await apps()).length === 1));
  const [rec] = await apps();
  assert.equal(rec.name, 'Fixture Radio App');
  assert.equal(rec.url, `${siteUrl}/media-share.html?app`, 'it opens the manifest’s start page');
  assert.equal(rec.profile, await L.main(() => global.lumio.current.profile.base.id), 'it remembers the profile it was installed from (batch 7a/7b)');
  if (MAC) {
    assert.equal(rec.launchers.length, 1);
    assert.ok(fs.existsSync(path.join(rec.launchers[0], 'Contents', 'MacOS', 'launch')), 'a launcher in Lumio Apps');
    assert.ok(fs.realpathSync(rec.launchers[0]).startsWith(fs.realpathSync(L.userData)), 'tests keep ~/Applications clean');
  }
  // Its window: the site under a slim title bar.
  const bar = (code) => L.main((_e, c) => [...global.lumio.pageTools.apps.windows][0]?.win.webContents.executeJavaScript(c), code);
  assert.ok(await until(() => L.main(() => [...global.lumio.pageTools.apps.windows][0]?.view.webContents.getURL().endsWith('?app'))));
  assert.ok(await until(async () => (await bar(`document.getElementById('title').textContent`)) === 'Fixture Radio'));
  assert.equal(await bar(`document.getElementById('away').hidden`), true, 'on its own site');
  assert.equal(await bar(`document.querySelector('[data-act="back"]').disabled`), true);
  // A launcher asks a running Lumio to open it: the window that's open comes forward.
  assert.equal(await L.main((_e, id) => global.lumio.pageTools.apps.launch(['/Lumio', `--lumio-app=${id}`]), rec.id), true);
  assert.equal(await L.main(() => global.lumio.pageTools.apps.windows.size), 1);
  // lumio://apps lists it.
  await L.main(() => global.lumio.cmd.apps());
  assert.ok(await until(() => L.page(`document.querySelector('.app .name')?.textContent === 'Fixture Radio App'`)));
  await shot('apps-page');
  // Removing it closes its window and takes its launcher away.
  assert.equal(await L.main((_e, id) => global.lumio.pageTools.apps.uninstall(id), rec.id), true);
  assert.ok(await until(() => L.main(() => global.lumio.pageTools.apps.windows.size === 0)));
  if (MAC) assert.equal(fs.existsSync(rec.launchers[0]), false);
  assert.deepEqual(await apps(), []);
});
