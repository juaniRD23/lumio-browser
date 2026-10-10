// End-to-end: Lumio AI's browser tools in an embedded frame from another
// site (main/ai/tools/frames.js), in the real app. The fixture's editor is a
// frame from localhost on a page from 127.0.0.1 (two sites, so Chromium runs
// it in its own process), with a frame of its own: read_page lists their
// fields after the page's, labelled by origin; type, click, Enter, click_at
// and paste_text work in them as real input; their password and card fields
// stay the person's; frames the person can't see (clipped, see-through,
// covered) aren't read; and Electron lists a page's frames in the order
// window[i] numbers them, which frames.js relies on to tell them apart. The
// tools run the way Lumio AI runs them, on the active tab.
// Run: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from '../../scripts/launch.mjs';

const FIX = path.join(root, 'tests', 'fixtures');
const SHOTS = process.env.LUMIO_SHOTS;
let L;
let site;
let base;

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await L.wait(150);
  }
};
// A browser tool, as Lumio AI runs it (approvals aside).
const tool = (name, args = {}) => L.main(async (_e, { name: n, args: a }) => {
  const t = global.lumio.ai.tools().find((x) => x.name === n);
  const ctx = { tabs: global.lumio.tabs, refs: global.lumio.ai.refs, showCursor: false, onPage() {}, onCapture() {} };
  const out = await t.run(a, ctx);
  return typeof out === 'string' ? { text: out, status: 'ok' } : { text: out.text, status: out.status || 'ok' };
}, { name, args });
// Code in the editor frame (depth 1) or the frame in it (depth 2).
const inFrame = (code, depth = 1) => L.main(async (_e, { code: c, depth: d }) => {
  let f = global.lumio.tabs.wc().mainFrame;
  for (let i = 0; i < d; i++) f = f.frames.find((x) => x.url.includes(i ? 'frames-nested.html' : 'frames-inner.html'));
  return f.executeJavaScript(c);
}, { code, depth });
const refIn = (text, name) => Number(text.match(new RegExp(`\\[(\\d+)\\] \\w+ "${name}"`))[1]);

before(async () => {
  site = http.createServer((q, r) => {
    const f = path.join(FIX, q.url.split('?')[0]);
    if (!f.startsWith(FIX) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end(fs.readFileSync(f));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${site.address().port}`;
  L = await launch();
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/frames-outer.html`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Order desk')));
  assert.ok(await until(() => inFrame(`document.readyState === 'complete' && !!document.getElementById('customer')`)), 'the editor loaded');
  assert.ok(await until(() => inFrame(`document.readyState === 'complete' && !!document.getElementById('deep')`, 2)), 'the frame in it loaded');
});

after(async () => {
  await L?.close();
  site?.close();
});

test('the editor is a frame from another site, running in its own process', async () => {
  const [page, frame, origin] = await L.main(() => {
    const main = global.lumio.tabs.wc().mainFrame;
    const f = main.frames.find((x) => x.url.includes('frames-inner.html'));
    return [main.processId, f.processId, f.origin];
  });
  assert.notEqual(frame, page);
  assert.match(origin, /^http:\/\/localhost:\d+$/);
});

test('read_page lists the frames’ fields after the page’s, and type, click, Enter and paste_text work in them', async () => {
  const read = await tool('read_page');
  const text = read.text;
  assert.match(text, /\[1\] button "Top button"/);
  assert.match(text, /Embedded frame from http:\/\/localhost:\d+ \("Embedded editor"\): part of this page, but its content comes from that site\./);
  assert.match(text, /Embedded frame from http:\/\/127\.0\.0\.1:\d+ \("Nested"\)[\s\S]*textbox "Deep field"/);
  assert.equal((text.match(/Deep field/g) || []).length, 2, 'the nested frame’s field and text, once: the hidden and 1px frames aren’t read');
  assert.ok(refIn(text, 'Customer') > 1, 'after the page’s refs');
  await shot('frames-01-read');

  const typed = await tool('type', { ref: refIn(text, 'Customer'), text: 'Sam Tester' });
  assert.match(typed.text, /^Typed into \[\d+\]\./);
  assert.equal(await inFrame(`document.getElementById('customer').value`), 'Sam Tester');
  assert.match((await tool('click', { ref: refIn(text, 'Save') })).text, /^Clicked \[\d+\]\./);
  assert.ok(await until(async () => (await inFrame(`document.getElementById('result').textContent`)) === 'Saved Sam Tester.'), 'the Save button got the click');
  // Enter after typing reaches the frame too.
  await inFrame(`document.getElementById('result').textContent = ''; true`);
  await tool('type', { ref: refIn(text, 'Customer'), text: 'Ana', submit: true });
  assert.ok(await until(async () => (await inFrame(`document.getElementById('result').textContent`)) === 'Saved Ana.'), 'Enter submitted the frame’s form');
  const events = await inFrame('window.events');
  for (const e of ['click:customer:true', 'input:customer:true', 'keydown:customer:true', 'click:save:true']) assert.ok(events.includes(e), `${e} in ${events.join(' ')}`);
  assert.ok(!events.some((e) => e.endsWith(':false')), 'all of it real input');
  // Two frames deep.
  await tool('type', { ref: refIn(text, 'Deep field'), text: 'deep' });
  assert.equal(await inFrame(`document.getElementById('deep').value`, 2), 'deep');
  // Pasted into a field in the frame (through the clipboard).
  await inFrame(`document.getElementById('customer').value = ''; true`);
  assert.match((await tool('paste_text', { ref: refIn(text, 'Customer'), text: 'Pasted name' })).text, /^Pasted 11 characters\./);
  assert.equal(await inFrame(`document.getElementById('customer').value`), 'Pasted name');
  await shot('frames-02-filled');
});

test('password and card fields in the frame stay the person’s', async () => {
  const text = (await tool('read_page')).text;
  const pw = await tool('type', { ref: refIn(text, 'Password'), text: 'hunter2' });
  assert.equal(pw.status, 'blocked');
  const card = await tool('type', { ref: refIn(text, 'Card number'), text: '4242 4242 4242 4242' });
  assert.equal(card.status, 'blocked');
  assert.match(card.text, /^Refused: this looks like a password, payment, or ID field/);
  // Focus put in the password field by a click: keys or a paste there are
  // refused too (and the field is let go, so it's clicked again).
  await tool('click', { ref: refIn(text, 'Password') });
  assert.equal((await tool('press_key', { keys: 'x' })).status, 'blocked');
  await tool('click', { ref: refIn(text, 'Password') });
  assert.equal((await tool('paste_text', { text: 'hunter2' })).status, 'blocked');
  assert.deepEqual(await inFrame(`[document.getElementById('pw').value, document.getElementById('card').value]`), ['', '']);
});

test('click_at on the frame’s field: a real click in the frame from another site (through DevTools)', async () => {
  await inFrame(`document.activeElement.blur(); window.events.length = 0; true`);
  // The editor's content starts inside its 6px border and 4px padding.
  const box = await L.page(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 }; })()`);
  const field = await inFrame(`(() => { const r = document.getElementById('customer').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const out = await L.main(async (_e, p) => {
    const ctx = { tabs: global.lumio.tabs, refs: global.lumio.ai.refs, showCursor: false, onPage() {}, onCapture() {} };
    const all = global.lumio.ai.tools();
    await all.find((t) => t.name === 'screenshot_tab').run({}, ctx);
    const k = global.lumio.tabs.wc().getZoomFactor() * ctx.lastTabShot.scale;
    const r = await all.find((t) => t.name === 'click_at').run({ x: p.x * k, y: p.y * k }, ctx);
    return typeof r === 'string' ? r : r.text;
  }, { x: box.x + field.x, y: box.y + field.y });
  assert.match(out, /^Clicked\./);
  assert.ok(await until(async () => (await inFrame('window.events')).includes('click:customer:true')), 'the field got a real click');
  assert.equal(await inFrame('document.activeElement.id'), 'customer');
});

test('Electron lists a page’s frames in the order window[i] numbers them (the order they were made), not where they are on the page', async () => {
  const other = base.replace('127.0.0.1', 'localhost');
  await L.page(`(() => {
    const make = (name, src) => Object.assign(document.createElement('iframe'), { name, src });
    const b = make('order-b', '${other}/frames-secret.html?b'); // another site
    document.body.append(b);
    const a = make('order-a', '/frames-secret.html?a'); // this site's, made second, put before b
    b.before(a);
    const c = make('order-c', '${other}/frames-secret.html?c'); // made third, put first
    document.body.prepend(c);
    return true;
  })()`);
  assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().mainFrame.frames.filter((f) => f.name.startsWith('order-')).length === 3)));
  const listed = await L.main(() => global.lumio.tabs.wc().mainFrame.frames.map((f) => f.name));
  const windowOrder = await L.page(`(() => { const els = [...document.querySelectorAll('iframe')]; return Array.from({ length: window.length }, (_, i) => els.find((e) => e.contentWindow === window[i])?.name ?? '?'); })()`);
  assert.deepEqual(listed, windowOrder);
  assert.deepEqual(windowOrder.filter((n) => n.startsWith('order-')), ['order-b', 'order-a', 'order-c']);
});

test('frames the person can’t see aren’t read: clipped to 1px, nearly transparent, under an opaque box', async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/frames-veiled.html`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Veiled')));
  assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().mainFrame.frames.length === 5 && global.lumio.tabs.wc().mainFrame.frames.every((f) => f.url.includes('frames-secret.html')))));
  await L.wait(500);
  const text = (await tool('read_page')).text;
  assert.equal((text.match(/jane@example\.com/g) || []).length, 1, text);
  assert.match(text, /2 more embedded frames mostly covered by something else on the page/);
});
