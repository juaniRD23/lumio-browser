// Lumio AI in embedded frames, in headless Chrome: a page with a frame from
// another site (127.0.0.1 and localhost are two sites, so Chromium runs it in
// a process of its own) holding a form and a frame of its own. The page
// scripts run in each frame and main/ai/tools/frames.js runs on a stand-in
// for Electron's WebFrameMain tree made of Playwright's frames; its input
// goes through DevTools' Input domain, as in the app. It finds and reads the
// shown frames (not the hidden one or the 1px one), numbers their refs after
// the page's, keeps password and card fields out, and its clicks, keys and
// text land in the right field, through borders, padding, a scaled frame and
// a scrolled page, two frames deep. Frames the person can't see (clipped,
// nearly transparent, covered) aren't read, nor clicked into; and the
// browser keeps a page's frames in the order window[i] numbers them, which is
// how frames.js tells which frame is which without taking a frame's word.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scripts = require('../main/ai/tools/page-scripts.js');
const frames = require('../main/ai/tools/frames.js');
const { parseKeys } = require('../main/ai/tools/browser.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

let browser;
let server;
let base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((q, r) => {
    const f = path.join(FIX, q.url.split('?')[0]);
    if (!f.startsWith(FIX) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// Electron's WebFrameMain tree, made of Playwright's frames: each runs code
// in its frame's own page, as frame.executeJavaScript() does.
function frameTree(page) {
  const made = new Map();
  let ids = 100;
  const wrap = (f) => {
    if (made.has(f)) return made.get(f);
    const w = {
      frameTreeNodeId: ++ids,
      get parent() { return f.parentFrame() ? wrap(f.parentFrame()) : null; },
      get frames() { return f.childFrames().map(wrap); },
      get framesInSubtree() { const all = []; const walk = (x) => { all.push(x); x.frames.forEach(walk); }; walk(w); return all; },
      get url() { return f.url(); },
      get origin() { return new URL(f.url()).origin; },
      get name() { return f.name(); },
      isDestroyed: () => f.isDetached(),
      executeJavaScript: (code) => f.evaluate(code),
    };
    made.set(f, w);
    return w;
  };
  return { main: wrap(page.mainFrame()), of: wrap };
}

async function open(name = 'frames-outer.html') {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`${base}/${name}`);
  const inner = () => page.frames().find((f) => f.url().includes('frames-inner.html'));
  if (name === 'frames-outer.html') for (let i = 0; i < 50 && !(inner() && inner().childFrames().length && page.frames().length >= 5); i++) await page.waitForTimeout(100);
  for (const f of page.frames()) await f.waitForLoadState('load');
  const cdp = await page.context().newCDPSession(page);
  const { main, of } = frameTree(page);
  // The tab: its main frame, the frame that has focus (as the browser
  // knows it: syncFocus() looks), and DevTools (wc.debugger) for input.
  const sent = [];
  const wc = {
    mainFrame: main,
    focusedFrame: main,
    debugger: { isAttached: () => true, sendCommand: (method, params) => { sent.push([method, params]); return cdp.send(method, params); } },
  };
  const syncFocus = async () => {
    let f = page.mainFrame();
    for (let depth = 0; depth < 6; depth++) {
      let next = null;
      for (const c of f.childFrames()) {
        const el = await c.frameElement().catch(() => null);
        if (el && await f.evaluate((e) => e === document.activeElement, el).catch(() => false)) { next = c; break; }
      }
      if (!next) break;
      f = next;
    }
    wc.focusedFrame = of(f);
  };
  const top = (fn, arg) => page.evaluate(`(${fn.toString()})(${JSON.stringify(arg || {})})`);
  const run = frames.runner(top, main);
  const nested = () => inner().childFrames()[0];
  return { page, cdp, wc, top, run, sent, inner, nested, syncFocus, of, innerFrame: () => of(inner()), nestedFrame: () => of(nested()) };
}

test('the frame from another site runs in its own process (what the rest of this file is about)', { skip }, async () => {
  const s = await open();
  const { targetInfos } = await s.cdp.send('Target.getTargets');
  assert.ok(targetInfos.some((t) => t.type === 'iframe' && t.url.includes('localhost') && t.url.includes('frames-inner.html')), 'an out-of-process frame');
  // Both sides find the same window index for it, across sites.
  const els = (await s.top(scripts.frameInfo, {})).frames;
  const editor = els.find((e) => e.name === 'editor');
  assert.equal(editor.index, 0);
  const self = await s.inner().evaluate(`(${scripts.frameInfo})({ self: true })`);
  assert.equal(self.index, 0);
  assert.deepEqual([self.vw, self.vh], [editor.cw, editor.ch], 'its viewport is the element’s content box');
  await s.page.close();
});

test('read: the shown frames, labelled by origin, refs after the page’s, no password or card digits', { skip }, async () => {
  const s = await open();
  await s.inner().evaluate(() => { document.getElementById('pw').value = 'hunter2'; document.getElementById('card').value = '4242 4242 4242 4242'; });
  const found = await frames.survey(s.wc.mainFrame, s.run);
  assert.deepEqual(found.frames.map((f) => [f.origin, f.status]), [[new URL(s.inner().url()).origin, 'read']], 'not the hidden frame, not the 1px one');
  assert.equal(found.frames[0].trusted, true, 'placed by the browser’s order, which every frame confirmed');
  assert.ok(frames.coverage(found) > 0.2 && frames.coverage(found) < 0.5);
  assert.equal(await s.page.$eval('#editor', (el) => el.getAttribute('data-lumio-frame')), String(s.innerFrame().frameTreeNodeId), 'marked for the tools');
  const snap = await s.top(scripts.snapshot, { max: 60, maxText: 2000 });
  const got = await frames.read(found, s.run, { start: snap.lines.length, elements: 220 - snap.lines.length, text: 5000, includeText: true });
  assert.equal(got.sections.length, 2, 'the editor and the frame in it');
  const [editor, deep] = got.sections;
  assert.match(editor.origin, /^http:\/\/localhost:\d+$/);
  assert.match(deep.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const firstRef = Number(editor.lines[0].match(/^\[(\d+)\]/)[1]);
  assert.equal(firstRef, snap.lines.length + 1, 'its refs go on after the page’s');
  const text = JSON.stringify(got);
  assert.ok(!text.includes('hunter2') && !text.includes('4242'), 'no password, no card number');
  assert.match(text, /password \\"Password\\" \(filled\)/);
  assert.match(text, /textbox \\"Card number\\" \(filled\)/);
  assert.equal(Object.values(got.meta).filter((m) => m.frame === s.innerFrame().frameTreeNodeId).length, editor.lines.length);
  assert.ok(Object.values(got.meta).some((m) => m.frame === s.nestedFrame().frameTreeNodeId && m.name === 'Deep field'));
  assert.equal((JSON.stringify(got.sections).match(/Deep field/g) || []).length, 2, 'the nested frame once (its line and its text), the hidden copies never');
  assert.deepEqual(got.read, [s.innerFrame().frameTreeNodeId, s.nestedFrame().frameTreeNodeId]);
  await s.page.close();
});

test('act: clicks land on the field in the frame (trusted), text and keys go to the focused frame, password fields are caught there', { skip }, async () => {
  const s = await open();
  const found = await frames.survey(s.wc.mainFrame, s.run);
  const snap = await s.top(scripts.snapshot, {});
  const got = await frames.read(found, s.run, { start: snap.lines.length, elements: 200, text: 0, includeText: false });
  const ref = (name) => Number(Object.entries(got.meta).find(([, m]) => m.name === name)[0]);
  const innerFrame = s.innerFrame();

  // Customer: the click goes in through the frame's border and padding.
  const at = await frames.place(innerFrame, ref('Customer'), s.run);
  assert.ok(!at.error, at.error);
  const box = await s.page.$eval('#editor', (el) => el.getBoundingClientRect().toJSON());
  assert.ok(at.x > box.left + 10 && at.x < box.right && at.y > box.top + 10 && at.y < box.bottom, 'inside the frame on the page');
  assert.equal(await frames.click(s.wc, at.x, at.y), true);
  assert.equal(await s.inner().evaluate(() => document.activeElement.id), 'customer');
  await s.syncFocus();
  const focus = await frames.focus(s.wc, s.top);
  assert.equal(focus.frame.frameTreeNodeId, innerFrame.frameTreeNodeId);
  assert.equal(focus.sensitive, false);
  assert.equal(await frames.insertText(s.wc, 'Sam Tester'), true);
  assert.equal(await s.inner().evaluate(() => document.getElementById('customer').value), 'Sam Tester');
  assert.equal(await frames.keys(s.wc, parseKeys('Enter')), true);
  await s.inner().waitForFunction(() => document.getElementById('result').textContent === 'Saved Sam Tester.');
  const events = await s.inner().evaluate(() => window.events);
  assert.ok(events.includes('click:customer:true') && events.includes('input:customer:true') && events.includes('keydown:customer:true'), events.join(' '));
  assert.ok(!events.some((e) => e.endsWith(':false')), 'all of it real input');

  // The password field in the frame: focus there is caught (and let go).
  const pw = await frames.place(innerFrame, ref('Password'), s.run);
  assert.equal(pw.sensitive, true, 'locate says so in the frame');
  await frames.click(s.wc, pw.x, pw.y);
  assert.equal(await s.inner().evaluate(() => document.activeElement.id), 'pw');
  await s.syncFocus();
  const onPw = await frames.focus(s.wc, s.top);
  assert.equal(onPw.sensitive, true);
  assert.notEqual(await s.inner().evaluate(() => document.activeElement.id), 'pw', 'blurred');
  await s.page.close();
});

test('act two frames deep, with the editor scaled down and the page scrolled', { skip }, async () => {
  const s = await open();
  await s.page.addStyleTag({ content: '#editor { transform: scale(0.75); transform-origin: 0 0; }' });
  await s.page.evaluate(() => window.scrollTo(0, 70));
  const found = await frames.survey(s.wc.mainFrame, s.run);
  const got = await frames.read(found, s.run, { start: 5, elements: 200, text: 0, includeText: false });
  const deepRef = Number(Object.entries(got.meta).find(([, m]) => m.name === 'Deep field')[0]);
  const at = await frames.place(s.nestedFrame(), deepRef, s.run);
  assert.ok(!at.error, at.error);
  // What Chrome itself says is at that point: the frame, then inside it the nested one.
  assert.equal(await s.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [at.x, at.y]), 'editor');
  await frames.click(s.wc, at.x, at.y);
  assert.equal(await s.nested().evaluate(() => document.activeElement.id), 'deep');
  assert.deepEqual(await s.nested().evaluate(() => window.events), ['click:deep:true']);
  await s.syncFocus();
  const focus = await frames.focus(s.wc, s.top);
  assert.equal(focus.frame.frameTreeNodeId, s.nestedFrame().frameTreeNodeId, 'focus is followed two frames down');
  await frames.insertText(s.wc, 'deep text');
  assert.equal(await s.nested().evaluate(() => document.getElementById('deep').value), 'deep text');
  // The Save button in the scaled editor.
  const saveRef = Number(Object.entries(got.meta).find(([, m]) => m.name === 'Save')[0]);
  const save = await frames.place(s.innerFrame(), saveRef, s.run);
  await frames.click(s.wc, save.x, save.y);
  await s.inner().waitForFunction(() => document.getElementById('result').textContent.startsWith('Saved'));
  assert.ok((await s.inner().evaluate(() => window.events)).includes('click:save:true'));
  await s.page.close();
});

test('screenshots: card digits in a frame show as dots while Lumio captures, under a key the page doesn’t know', { skip }, async () => {
  const s = await open();
  await s.inner().evaluate(() => { document.getElementById('card').value = '4242 4242 4242 4242'; });
  await frames.mask(s.wc, true);
  assert.equal(await s.inner().evaluate(() => getComputedStyle(document.getElementById('card')).webkitTextSecurity), 'disc');
  assert.equal(await s.inner().evaluate(() => '__lumioMasked' in window), false);
  await frames.mask(s.wc, false);
  assert.equal(await s.inner().evaluate(() => document.getElementById('card').style.cssText), '');
  await s.page.close();
});

test('a page’s frames are numbered in window[i] in the order they were made, not where they are on the page (frames.js matches the browser’s list to that)', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`${base}/frames-nested.html`);
  const other = base.replace('127.0.0.1', 'localhost');
  await page.evaluate((o) => {
    const make = (name, src) => Object.assign(document.createElement('iframe'), { name, src });
    const b = make('b', '/frames-secret.html?b');
    document.body.append(b);
    const a = make('a', '/frames-secret.html?a'); // made second, put before b
    b.before(a);
    const c = make('c', '/frames-secret.html?c');
    a.after(c); // made third, between them
    const e = make('e', `${o}/frames-secret.html?e`); // from another site (its own process), made fourth, put first
    document.body.prepend(e);
    const d = make('d', '/frames-secret.html?d');
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).append(d); // in a shadow root
    document.body.prepend(host);
  }, other);
  for (let i = 0; i < 50 && page.frames().length < 6; i++) await page.waitForTimeout(100);
  const windowOrder = await page.evaluate(() => {
    const els = [...document.querySelectorAll('iframe')];
    return Array.from({ length: window.length }, (_, i) => els.find((e) => e.contentWindow === window[i])?.name || '?');
  });
  assert.deepEqual(windowOrder, ['b', 'a', 'c', 'e'], 'the order they were made; the one in a shadow root isn’t in the window');
  // The renderer's frame tree (DevTools lists its own process's frames) is in that order too.
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  assert.deepEqual((frameTree.childFrames || []).map((c) => c.frame.name).filter((n) => n !== 'd'), ['b', 'a', 'c']);
  const info = await page.evaluate(`(${scripts.frameInfo})({})`);
  assert.equal(info.count, 4);
  assert.equal(info.shadow, 1, 'frames.js knows not to use the order here');
  await page.close();
});

test('frames the person can’t see aren’t read: clipped to 1px, nearly transparent, under an opaque box (even one that lets clicks through)', { skip }, async () => {
  const s = await open('frames-veiled.html');
  for (let i = 0; i < 50 && s.page.frames().length < 6; i++) await s.page.waitForTimeout(100);
  for (const f of s.page.frames()) await f.waitForLoadState('load');
  const els = (await s.top(scripts.frameInfo, {})).frames;
  const by = (id) => els.find((e) => e.src.endsWith(`?${id}`));
  assert.equal(by('plain').hit, 1);
  assert.equal(by('plain').shown, true);
  assert.equal(by('faint').shown, false, 'opacity 0.01');
  assert.ok(!by('clipped').vis || by('clipped').vis.h <= 1, 'clipped to its 1px-tall box');
  assert.equal(by('under').hit, 0, 'under an opaque box');
  assert.equal(by('ghosted').hit, 0, 'under an opaque box that lets clicks through');
  const found = await frames.survey(s.wc.mainFrame, s.run);
  const status = Object.fromEntries(found.frames.map((f) => [new URL(f.url).search.slice(1), f.status]));
  assert.deepEqual(status, { plain: 'read', under: 'covered', ghosted: 'covered' });
  const got = await frames.read(found, s.run, { start: 0, elements: 200, text: 5000, includeText: true });
  assert.equal((JSON.stringify(got.sections).match(/jane@example\.com/g) || []).length, 1, 'only the one in plain view');
  assert.match(got.notes.join(' '), /2 more embedded frames mostly covered/);
  // No click goes into a covered frame either: it would hit what covers it.
  const ghosted = s.of(s.page.frames().find((f) => f.url().endsWith('?ghosted')));
  await s.page.frames().find((f) => f.url().endsWith('?ghosted')).evaluate(`(${scripts.snapshot})({ start: 40 })`);
  const at = await frames.place(ghosted, 41, s.run);
  assert.match(at.error || '', /covered there by div "Nothing here either"/);
  const under = s.of(s.page.frames().find((f) => f.url().endsWith('?under')));
  await s.page.frames().find((f) => f.url().endsWith('?under')).evaluate(`(${scripts.snapshot})({ start: 50 })`);
  assert.match((await frames.place(under, 51, s.run)).error || '', /covered there by div "Nothing to see"/);
  // The plain one: placed, clicked, and the click is real.
  const plainFrame = s.page.frames().find((f) => f.url().endsWith('?plain'));
  const transfer = Number(Object.entries(got.meta).find(([, m]) => m.name === 'Transfer')[0]);
  const ok = await frames.place(s.of(plainFrame), transfer, s.run);
  assert.ok(!ok.error, ok.error);
  await frames.click(s.wc, ok.x, ok.y);
  assert.deepEqual(await plainFrame.evaluate(() => window.events), ['click:transfer:true']);
  await s.page.close();
});

test('click_at: which frame is at a point (the page’s own, or one from another site that only DevTools’ input reaches)', { skip }, async () => {
  const s = await open();
  const box = await s.page.$eval('#editor', (el) => el.getBoundingClientRect().toJSON());
  const onEditor = await frames.frameAt(s.wc, s.top, { x: box.left + 100, y: box.top + 40 });
  assert.equal(onEditor.frame?.frameTreeNodeId, s.innerFrame().frameTreeNodeId);
  assert.equal(onEditor.payment, undefined);
  const onPage = await frames.frameAt(s.wc, s.top, { x: 20, y: 20 });
  assert.equal(onPage.frame, null);
  // The customer field through click_at's route: a real click in the frame.
  const field = await s.inner().$eval('#customer', (el) => el.getBoundingClientRect().toJSON());
  const x = box.left + 6 + 4 + field.left + 10;
  const y = box.top + 6 + 4 + field.top + 5;
  assert.equal((await frames.frameAt(s.wc, s.top, { x, y })).frame?.frameTreeNodeId, s.innerFrame().frameTreeNodeId);
  await frames.click(s.wc, x, y);
  assert.equal(await s.inner().evaluate(() => document.activeElement.id), 'customer');
  await s.page.close();
});
