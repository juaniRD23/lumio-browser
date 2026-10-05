// The page tools' scripts that run inside web pages, in headless Chrome:
// websites' navigator.share() and Media Session handlers (the shim in
// preload/internal.js), what the media controls read and do
// (main/media.js), the right-click menu's video actions and Copy link to
// highlight (main/page-menu.js), and what Install app reads from a page
// (main/apps.js). Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { probeMedia, controlMedia } = require('../main/media.js');
const { mediaAction, highlightLink } = require('../main/page-menu.js');
const { pageAppInfo } = require('../main/apps.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';

// The shim runs in the page's own world; the preload hands it a bridge.
const preload = fs.readFileSync(path.join(ROOT, 'preload', 'internal.js'), 'utf8');
const SHIM = preload.slice(preload.indexOf('function installPageApis(bridge) {'), preload.indexOf('\n}\n', preload.indexOf('function installPageApis(bridge) {')) + 2);

const PAGE = `<!doctype html><html lang="en"><head><title>Mail – Inbox</title>
<link rel="manifest" href="/manifest.json"><link rel="icon" href="/favicon.png" sizes="32x32"><link rel="apple-touch-icon" href="/touch.png">
<meta name="application-name" content="Example Mail"></head><body>
<p id="a">The lighthouse keeper lit the lamp at dusk.</p>
<p id="b">Every night the lamp was lit at dusk, and the ships came home.</p>
<p id="c">${'Long words go here and keep going for a while. '.repeat(6)}</p>
<button id="go">Share</button>
<video id="v" width="160" height="90" muted></video><audio id="s"></audio>
</body></html>`;

let server;
let browser;
let base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`; // a secure context, like https sites
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); server?.close(); });

// shim: the page gets the shim before its own scripts, like from the
// preload, with a stand-in bridge (window.__shared, __actions, __run). It
// also tries to share as it loads, before anything is clicked (__noClick).
async function open({ shim = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (shim) {
    await page.addInitScript((src) => {
      window.__shared = [];
      window.__actions = [];
      (0, eval)(`(${src})`)({
        share: async (data) => { window.__shared.push(data); return window.__answer ?? { ok: true }; },
        mediaActions: (list) => window.__actions.push(list),
        mediaConnect: (run) => { window.__run = run; },
      });
      addEventListener('load', () => navigator.share({ url: '/' }).then(() => { window.__noClick = 'shared'; }, (e) => { window.__noClick = e.name; }));
    }, SHIM);
  }
  await page.goto(base + '/');
  return { page, errors };
}
// Calls navigator.share() from a click, like a site's Share button. data: a
// JS expression, run in the page.
async function shareFromClick(page, data) {
  await page.evaluate((d) => {
    window.__result = null;
    document.getElementById('go').onclick = () => navigator.share((0, eval)(`(${d})`)).then(() => { window.__result = 'shared'; }, (e) => { window.__result = `${e.name}: ${e.message}`; });
  }, data);
  await page.click('#go');
  await page.waitForFunction(() => window.__result !== null);
  return page.evaluate(() => window.__result);
}

test('navigator.share() asks Lumio, with clean data, and only from a click', { skip }, async () => {
  const { page, errors } = await open({ shim: true });
  // Not from a click: refused.
  await page.waitForFunction(() => window.__noClick);
  assert.equal(await page.evaluate(() => window.__noClick), 'NotAllowedError');
  assert.equal(await page.evaluate(() => String(navigator.share)), 'function share() { [native code] }');
  assert.equal(await shareFromClick(page, "{ title: 'Hi', text: 'Look', url: '/story?x=1', extra: 'ignored' }"), 'shared');
  assert.deepEqual(await page.evaluate(() => window.__shared), [{ title: 'Hi', text: 'Look', url: `${base}/story?x=1` }]);
  // Canceled in Lumio: the page gets an AbortError.
  await page.evaluate(() => { window.__answer = { error: 'AbortError', message: 'Share canceled' }; });
  assert.equal(await shareFromClick(page, "{ url: 'https://a.example/' }"), 'AbortError: Share canceled');
  // Files can't be shared, and script links and empty shares are refused.
  assert.match(await shareFromClick(page, "{ files: [new File(['x'], 'a.txt')] }"), /^NotAllowedError/);
  assert.match(await shareFromClick(page, "{ url: 'javascript:alert(1)' }"), /^TypeError: Invalid URL/);
  assert.match(await shareFromClick(page, '{}'), /^TypeError/);
  assert.equal(await page.evaluate(() => window.__shared.length), 2, 'refused shares never reach Lumio');
  assert.deepEqual(await page.evaluate(() => [navigator.canShare({ url: '/' }), navigator.canShare({ files: [new File(['x'], 'a.txt')] }), navigator.canShare({})]), [true, false, false]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the site’s Media Session handlers still work, and Lumio can run them too', { skip }, async () => {
  const { page, errors } = await open({ shim: true });
  await page.evaluate(() => {
    window.__ran = [];
    navigator.mediaSession.setActionHandler('nexttrack', (d) => window.__ran.push(['next', d.action]));
    navigator.mediaSession.setActionHandler('seekto', (d) => window.__ran.push(['seek', d.seekTime]));
    navigator.mediaSession.setActionHandler('nexttrack', null);
    navigator.mediaSession.setActionHandler('previoustrack', (d) => window.__ran.push(['prev', d.action]));
  });
  assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), ['seekto', 'previoustrack']);
  await page.evaluate(() => { window.__run('previoustrack', {}); window.__run('seekto', { seekTime: 30 }); window.__run('nexttrack', {}); });
  assert.deepEqual(await page.evaluate(() => window.__ran), [['prev', 'previoustrack'], ['seek', 30]]);
  // Unknown actions still throw, as before.
  assert.equal(await page.evaluate(() => { try { navigator.mediaSession.setActionHandler('dance', () => {}); return 'no error'; } catch (e) { return e.name; } }), 'TypeError');
  assert.deepEqual(errors, []);
  await page.close();
});

test('what’s playing: the Media Session’s title and artwork, and the player’s state', { skip }, async () => {
  const { page, errors } = await open();
  // A second of quiet audio, playing.
  await page.evaluate(async () => {
    const rate = 8000;
    const wav = new DataView(new ArrayBuffer(44 + rate * 2));
    const put = (o, s) => [...s].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
    put(0, 'RIFF'); wav.setUint32(4, 36 + rate * 2, true); put(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
    wav.setUint32(24, rate, true); wav.setUint32(28, rate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); put(36, 'data'); wav.setUint32(40, rate * 2, true);
    const audio = document.getElementById('s');
    audio.src = URL.createObjectURL(new Blob([wav.buffer], { type: 'audio/wav' }));
    audio.loop = true;
    await audio.play();
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Song', artist: 'Band', album: 'Album', artwork: [{ src: 'https://cdn.example/a.jpg', sizes: '512x512' }] });
  });
  const info = await page.evaluate(`(${probeMedia})()`);
  assert.equal(info.title, 'Song');
  assert.equal(info.artist, 'Band');
  assert.deepEqual(info.artwork, [{ src: 'https://cdn.example/a.jpg', sizes: '512x512' }]);
  assert.equal(info.el.paused, false);
  assert.ok(Math.abs(info.el.duration - 1) < 0.01);
  assert.equal(info.el.video, false);
  assert.equal(info.el.canPip, false, 'audio has no Picture in picture');
  // Pause pauses what's playing; seek and play work on the same player.
  assert.equal(await page.evaluate(`(${controlMedia})("pause", null)`), true);
  assert.equal(await page.evaluate(() => document.getElementById('s').paused), true);
  await page.evaluate(`(${controlMedia})("seek", 0.5)`);
  assert.equal(await page.evaluate(() => document.getElementById('s').currentTime), 0.5);
  await page.evaluate(`(${controlMedia})("play", null)`);
  await page.waitForFunction(() => !document.getElementById('s').paused);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a video’s right-click actions and Picture in picture', { skip }, async () => {
  const { page, errors } = await open();
  // A video from a canvas, and a stand-in for Picture in picture (headless has none).
  await page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
    const ctx = c.getContext('2d');
    setInterval(() => { ctx.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`; ctx.fillRect(0, 0, 160, 90); }, 30);
    const v = document.getElementById('v');
    v.srcObject = c.captureStream(30);
    await v.play();
    window.__pip = [];
    Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { get: () => true });
    HTMLVideoElement.prototype.requestPictureInPicture = function requestPictureInPicture() { window.__pip.push(this.id); return Promise.resolve({}); };
  });
  await page.waitForFunction(() => document.getElementById('v').videoWidth > 0);
  const box = await page.$eval('#v', (v) => { const r = v.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; });
  const run = (action, at = box) => page.evaluate(`(${mediaAction})(${JSON.stringify(action)}, ${at ? at.x : null}, ${at ? at.y : null}, "")`);
  assert.equal(await run('loop'), true);
  assert.equal(await page.$eval('#v', (v) => v.loop), true);
  await run('controls');
  assert.equal(await page.$eval('#v', (v) => v.controls), true);
  await run('pip');
  assert.deepEqual(await page.evaluate(() => window.__pip), ['v']);
  await run('play');
  assert.equal(await page.$eval('#v', (v) => v.paused), true, 'Play/Pause toggles');
  // In a frame there's no spot: the only player, or the one with that address.
  assert.equal(await run('mute', null), false, 'two players and no address: nothing is guessed');
  assert.equal(await run('nothing-here', { x: 5, y: 5 }), false, 'no player at that spot');
  // The media controls' Picture in picture finds the video.
  await page.evaluate(() => document.getElementById('v').play());
  await page.evaluate(`(${controlMedia})("pip", null)`);
  assert.deepEqual(await page.evaluate(() => window.__pip), ['v', 'v']);
  const info = await page.evaluate(`(${probeMedia})()`);
  assert.equal(info.el.video, true);
  assert.equal(info.el.canPip, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Copy link to highlight: a text fragment that finds the right words', { skip }, async () => {
  const { page, errors } = await open();
  // Selects from the first `from` to the end of the first `to` (all of it without them).
  const select = (id, from, to) => page.evaluate(({ id, from, to }) => {
    const text = document.getElementById(id).firstChild;
    const r = document.createRange();
    r.setStart(text, from ? text.data.indexOf(from) : 0);
    r.setEnd(text, to ? text.data.indexOf(to) + to.length : text.data.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, { id, from, to });
  const link = () => page.evaluate(`(${highlightLink})()`);
  // Words found once: just them.
  await select('a', 'keeper', 'lamp');
  assert.equal(await link(), `${base}/#:~:text=keeper%20lit%20the%20lamp`);
  // "at dusk" is on the page twice: the words around it pick the right one.
  await select('b', 'at', 'dusk');
  assert.equal(await link(), `${base}/#:~:text=lamp%20was%20lit-,at%20dusk,-%2C%20and%20the`);
  // A long selection: its first and last words (here with the words around them, as they repeat).
  await select('c');
  assert.equal(await link(), `${base}/#:~:text=ships%20came%20home.-,Long%20words%20go%20here,going%20for%20a%20while.,-Share`);
  // Dashes in the words are escaped, since they mean something in the fragment.
  await page.evaluate(() => { document.getElementById('a').firstChild.data = 'A well-known keeper.'; });
  await select('a', 'well', 'keeper');
  assert.equal(await link(), `${base}/#:~:text=well%2Dknown%20keeper`);
  await page.evaluate(() => getSelection().removeAllRanges());
  assert.equal(await link(), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Install app reads the page’s manifest, icons and names', { skip }, async () => {
  const { page } = await open();
  const info = await page.evaluate(`(${pageAppInfo})()`);
  assert.equal(info.manifest, `${base}/manifest.json`);
  assert.equal(info.name, 'Example Mail');
  assert.equal(info.title, 'Mail – Inbox');
  assert.deepEqual(info.icons, [
    { src: `${base}/favicon.png`, sizes: '32x32', type: '', touch: false },
    { src: `${base}/touch.png`, sizes: '', type: '', touch: true },
  ]);
  await page.close();
});
