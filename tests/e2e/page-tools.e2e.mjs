// End-to-end tests for translating pages and reading mode, in the real app
// against a stand-in Lumio server (tests/mock-lumio.mjs).
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
const go = (url) => L.main((_e, u) => global.lumio.tabs.navigate(u), url);
// Runs JS in the window's dropdown view (the translate bubble).
const overlay = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);

before(async () => {
  site = http.createServer((q, r) => {
    const f = path.join(FIX, q.url.split('?')[0]);
    if (!f.startsWith(FIX) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end(fs.readFileSync(f));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  lumio = await startMockLumio({ plan: 'free' });
  L = await launch({ env: { LUMIO_ACCOUNT_BASE: lumio.base, LUMIO_AI_BASE: lumio.base } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(800);
  // Sign in on the stand-in website.
  await L.main(() => global.lumio.signIn());
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === 'Sign in · Lumio');
  await L.page(`document.getElementById('continue').click(); true`);
  assert.ok(await until(() => L.main(() => global.lumio.account.state().signedIn), 15_000));
});

after(async () => {
  await L?.close();
  site?.close();
  lumio?.server.close();
});

test('a page in French: the Translate button and bubble, translated in place, and Show original', async () => {
  await go(`${siteUrl}/article-fr.html`);
  assert.ok(await until(() => L.main(() => global.lumio.tabs.active?.translate?.status === 'offer')), 'French is noticed');
  assert.ok(await until(() => L.shell(`!document.getElementById('translate-btn').hidden`)));
  // The bubble offers it by itself.
  assert.ok(await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'translate')));
  assert.ok(await until(() => overlay(`document.querySelector('.tb-title')?.textContent === 'Translate this page?'`)));
  await shot('translate-offer');
  await overlay(`document.querySelector('[data-act="translate"]').click(); true`);
  assert.ok(await until(() => L.page(`document.querySelector('h1').textContent.startsWith('[en] ')`)), 'the heading is translated');
  assert.ok(await until(() => L.main(() => global.lumio.tabs.active.translate.status === 'translated')));
  const req = lumio.state.translate[0];
  assert.deepEqual([req.source, req.target], ['fr', 'en']);
  assert.ok(req.blocks.some((b) => b.includes('Lisez la suite de leur histoire')), 'the link’s text goes with its paragraph');
  assert.ok(!JSON.stringify(req.blocks).includes('phare-42'), 'code isn’t sent');
  // Links and fields are untouched.
  assert.deepEqual(await L.page(`[document.getElementById('lien').getAttribute('href'), document.getElementById('lien').textContent, document.getElementById('q').value]`), ['/source', '[en] Lisez la suite de leur histoire', 'phare']);
  assert.equal(await L.shell(`document.getElementById('translate-btn').classList.contains('on')`), true);
  await shot('translate-done');
  // Show original, from the bubble.
  await L.shell(`document.getElementById('translate-btn').click(); true`);
  assert.ok(await until(() => overlay(`!!document.querySelector('[data-act="original"]')`)));
  await overlay(`document.querySelector('[data-act="original"]').click(); true`);
  assert.ok(await until(() => L.page(`document.querySelector('h1').textContent === 'L’histoire tranquille des phares'`)));
  assert.equal(await L.page(`document.getElementById('lien').textContent`), 'Lisez la suite de leur histoire');
  // Never translate French: the button goes away.
  await overlay(`document.querySelector('[data-act="never"]').click(); true`);
  assert.ok(await until(() => L.main(() => global.lumio.tabs.active.translate.status === 'never')));
  assert.deepEqual(await L.main(() => global.lumio.store.settings.translate.never), ['fr']);
  await overlay(`document.querySelector('.tb-x').click(); true`);
  assert.ok(await until(() => L.shell(`document.getElementById('translate-btn').hidden`)));
  await L.main(() => global.lumio.store.setSetting('translate', {}));
});

test('reading mode: the article in its own column, Read aloud with Lumio’s voice, and View › Reading Mode', async () => {
  await go(`${siteUrl}/article.html`);
  assert.ok(await until(() => L.shell(`!document.getElementById('reader-btn').hidden`)), 'the button shows on an article');
  const before = await L.main(() => global.lumio.tabs.active.view.getBounds().width);
  await L.shell(`document.getElementById('reader-btn').click(); true`);
  assert.ok(await until(() => L.shell(`document.querySelector('#reader .rd-title')?.textContent === 'The Quiet History of Lighthouses'`)));
  assert.match(await L.shell(`document.querySelector('#reader .rd-body').textContent`), /Pharos of Alexandria/);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.active.view.getBounds().width)) < before - 250), 'the page makes room');
  await shot('reading-mode');
  // Read aloud asks Lumio's voice for the first sentences.
  await L.shell(`document.querySelector('#reader [data-rd="play"]').click(); true`);
  assert.ok(await until(() => Promise.resolve(lumio.state.voice.some((v) => v.path === '/v1/voice/speak' && /^The Quiet History of Lighthouses/.test(v.body.text)))));
  // The settings are kept.
  await L.shell(`document.querySelector('#reader [data-rd="settings"]').click(); document.querySelector('#reader [data-pref="theme"] [data-v="sepia"]').click(); true`);
  assert.ok(await until(() => L.main(() => global.lumio.store.settings.reader?.theme === 'sepia')));
  // Closing gives the page its room back; the View menu opens it again.
  await L.shell(`document.querySelector('#reader [data-rd="close"]').click(); true`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.active.view.getBounds().width)) === before));
  await L.main(() => global.lumio.cmd.readingMode());
  assert.ok(await until(() => L.shell(`!document.getElementById('reader').classList.contains('closed') && !!document.querySelector('#reader .rd-title')`)));
  await L.main(() => global.lumio.cmd.readingMode());
});
