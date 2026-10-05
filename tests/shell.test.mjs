// Smoke test for the window's UI (renderer/ui/shell.html and the AI panel):
// loads it in headless Chrome with a stand-in for the main process and fails
// on any error while it starts. A startup error breaks the whole window (and
// nearly every e2e test), so this catches it in seconds instead of a full
// e2e run. It also checks the window in light and dark. Skipped when Google
// Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

// What the main process answers while the window starts (see main.js shell:init).
const AI = { ready: true, lumio: { signedIn: true, plan: 'free', usage: { used: 0.38, fullAt: Date.now() + 864e5 } }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], mode: 'ask', running: false, vision: true, macAvailable: true };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc', favicon: null, loading: false, canGoBack: false, canGoForward: false, pinned: false, pdf: false }] },
  downloads: [], panel: { open: true, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'Test Person', email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.3', update: null,
};

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    const url = new URL(`lumio://shell${req.url}`);
    const file = resolveFile(url, new Set(['shell']));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    // An incognito window's UI asks to be served already dark (see main/protocol.js).
    if (file.endsWith('.html') && url.searchParams.get('appearance') === 'dark') body = String(body).replace(/<html\b/i, '<html data-appearance="dark"');
    // The window's real Content-Security-Policy, so the tests hit what the app enforces.
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// Opens the window UI with a stand-in main process. `answers` adds or replaces
// what ai:… calls return; every call is recorded in window.__calls.
// colorScheme is the computer's light or dark; query is added to the address
// (?appearance=dark, as an incognito window asks for).
async function openShell(b, answers = {}, { colorScheme, query = '' } = {}) {
  const page = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ init, ai, extra }) => {
    const handlers = {};
    window.__sent = [];
    window.__calls = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] }, 'ai:set-mode': (m) => ({ ...ai, mode: m }) };
    for (const [k, v] of Object.entries(extra)) answers[k] = v.fn ? new Function('...args', v.fn) : v.value;
    window.lumio = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, args[0]]); const a = answers[channel]; return typeof a === 'function' ? a(...args) : a ?? null; },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { init: INIT, ai: AI, extra: answers });
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(() => document.getElementById('mode-name')?.textContent === 'Ask', null, { timeout: 10_000 }).catch(() => {});
  return { page, errors };
}

test('the window and AI panel start without errors, and the composer works', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openShell(browser);
  assert.deepEqual(errors, [], 'no errors while starting');

  // Approvals: one button; its menu switches the mode.
  await page.click('#mode-btn');
  assert.equal(await page.isVisible('#mode-menu'), true);
  await page.click('#mode-menu [data-mode="auto"]');
  await page.waitForFunction(() => document.getElementById('mode-name').textContent === 'Auto');
  assert.equal(await page.isVisible('#mode-menu'), false);

  // An empty box offers voice mode where Send is; typing brings Send back.
  assert.equal(await page.isVisible('#voice-btn'), true);
  assert.equal(await page.isVisible('#send'), false);
  await page.fill('#prompt', 'hello');
  assert.equal(await page.isVisible('#send'), true);
  assert.equal(await page.isVisible('#voice-btn'), false);
  await page.fill('#prompt', '');

  // On a YouTube video, the panel offers a summary.
  assert.match(await page.textContent('#page-suggest'), /Summarize this video/);

  // The + menu has "Ask about my tabs", which sets the chip.
  await page.click('#plus-btn');
  await page.click('#add-tabs');
  assert.equal(await page.textContent('#context-chip span'), 'All open tabs');
  // Helper AIs: a colored dot on each helper's tab, and a row per helper in the chat.
  await page.evaluate(() => {
    window.__emit('tabs', { activeId: 1, tabs: [
      { id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' },
      { id: 7, title: 'Best Buy', url: 'https://www.bestbuy.com/', agent: { color: '#b58cff', name: 'Helper 2', title: 'Best Buy price' } },
    ] });
    window.__emit('ai-event', { chatId: 'c9', type: 'user', text: 'compare prices' });
    window.__emit('ai-event', { chatId: 'c9', type: 'start' });
    window.__emit('ai-event', { chatId: 'c9', type: 'step', id: 'call_h', name: 'send_helpers', label: 'Sending 2 helpers', icon: 'helpers', risk: 'read' });
    window.__emit('ai-event', { chatId: 'c9', type: 'helper', parent: 'call_h', helper: { n: 2, title: 'Best Buy price', color: '#b58cff', colorName: 'Purple', status: 'working', label: 'Reading bestbuy.com', tabId: 7 } });
  });
  const dot = await page.$$eval('.tab .agent-dot', (els) => els.map((e) => ({ hidden: e.hidden, color: e.style.getPropertyValue('--c') })));
  assert.deepEqual(dot, [{ hidden: true, color: '' }, { hidden: false, color: '#b58cff' }]);
  assert.match(await page.textContent('.helpers .helper'), /Best Buy price.*Reading bestbuy\.com/);
  await page.click('.helpers .helper');
  assert.deepEqual(await page.evaluate(() => window.__sent.filter(([c]) => c === 'tab:activate').at(-1)), ['tab:activate', 7], 'a row opens its tab');
  await page.evaluate(() => window.__emit('ai-event', { chatId: 'c9', type: 'helper', parent: 'call_h', helper: { n: 2, title: 'Best Buy price', color: '#b58cff', status: 'done', label: 'Reported back', tabId: 7 } }));
  assert.equal(await page.$$eval('.helpers .helper', (els) => els.length), 1, 'updates in place');
  assert.match(await page.textContent('.helpers .helper'), /Reported back/);
  assert.deepEqual(errors, [], 'no errors while using it');
});

test('bookmarks bar: under the address bar, icons, the new tab page, right-click and drops', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openShell(browser);
  await page.route('https://c.example/favicon.ico', (r) => r.fulfill({ status: 404, body: '' }));
  const lastSent = (channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).at(-1)?.[1], channel);

  // Turned off, on a web page: hidden. The new tab page shows it anyway (like Chrome), with a way to import.
  assert.equal(await page.isVisible('#bookmarks-bar'), false);
  await page.evaluate(() => window.__emit('tabs', { activeId: 2, tabs: [{ id: 2, title: 'New Tab', url: '' }] }));
  assert.equal(await page.isVisible('#bookmarks-bar'), true);
  assert.match(await page.textContent('#bookmarks-bar'), /For quick access, bookmark pages with (⌘D|Ctrl\+D)/);
  await page.click('#bm-import');
  assert.deepEqual(await lastSent('bookmarks:open'), { url: 'lumio://settings/#import', disposition: 'tab' });

  // Turned on: on every page, right under the address bar.
  const firstIcon = await page.evaluate(() => {
    window.__emit('tabs', { activeId: 1, tabs: [{ id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' }] });
    window.__emit('bookmarks', { show: true, items: [
      { id: 'a1', url: 'https://a.example/', title: 'Alpha', favicon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
      { id: 'b2', url: 'https://b.example/page', title: 'Beta', favicon: null },
      { id: 'c3', url: 'https://c.example/', title: 'Gamma', favicon: null },
    ], other: { id: 'other', title: 'Other bookmarks', children: [] }, mobile: { id: 'mobile', title: 'Mobile bookmarks', children: [] }, folders: [], recent: [] });
    return document.querySelector('.bm-item[data-i="1"] img')?.getAttribute('src'); // before it loads (or fails)
  });
  assert.deepEqual(await page.$$eval('.bm-items .bm-item span', (els) => els.map((e) => e.textContent)), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(await page.isVisible('#bm-all'), true, 'All bookmarks at the right end');
  const [toolbar, barBox] = await page.evaluate(() => ['toolbar', 'bookmarks-bar'].map((id) => document.getElementById(id).getBoundingClientRect().toJSON()));
  assert.ok(barBox.top >= toolbar.bottom - 1 && barBox.top - toolbar.bottom < 6, 'right under the address bar');
  // A bookmark without an icon yet shows its site's /favicon.ico; a site without one gets the globe.
  assert.equal(firstIcon, 'https://b.example/favicon.ico');
  await page.waitForFunction(() => !document.querySelector('.bm-item[data-i="2"] img') && !!document.querySelector('.bm-item[data-i="2"] svg'));

  // Right-click: on a bookmark, its menu; on the bar itself, the bar's menu.
  await page.click('.bm-item[data-i="1"]', { button: 'right' });
  assert.equal(await lastSent('bookmarks:context'), 'b2');
  const r = await page.evaluate(() => document.querySelector('#bookmarks-bar .bm-items').getBoundingClientRect().toJSON());
  await page.mouse.click(r.right - 30, r.top + r.height / 2, { button: 'right' });
  assert.equal(await lastSent('bookmarks:context'), null);

  // Dropping a link before Beta adds it there, named after the link's text.
  const marked = await page.evaluate(() => {
    const bar = document.getElementById('bookmarks-bar');
    const beta = bar.querySelector('.bm-item[data-i="1"]').getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'https://d.example/');
    dt.setData('text/html', '<a href="https://d.example/">Delta site</a>');
    const at = { dataTransfer: dt, clientX: beta.left + 3, clientY: beta.top + 5, bubbles: true, cancelable: true };
    bar.dispatchEvent(new DragEvent('dragover', at));
    const shown = bar.querySelector('.bm-item[data-i="1"]').classList.contains('drop-before');
    bar.dispatchEvent(new DragEvent('drop', at));
    return shown;
  });
  assert.equal(marked, true, 'a marker shows where it lands');
  assert.deepEqual(await lastSent('bookmarks:add'), { url: 'https://d.example/', title: 'Delta site', parentId: 'bar', index: 1 });
  assert.equal(await page.$$eval('.drop-before, .drop-after', (els) => els.length), 0);
  // Dragging Alpha past Gamma moves it to the end.
  await page.evaluate(() => {
    const bar = document.getElementById('bookmarks-bar');
    const [alpha, , gamma] = bar.querySelectorAll('.bm-items .bm-item');
    const dt = new DataTransfer();
    alpha.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const g = gamma.getBoundingClientRect();
    bar.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: g.right + 4, clientY: g.top + 5, bubbles: true, cancelable: true }));
    alpha.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
  assert.deepEqual(await lastSent('bookmarks:move'), { ids: ['a1'], parentId: 'bar', index: 3 }, 'before what\'s at 3: the end');
  // The address bar's site icon drags as a link to the page.
  const dragged = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.getElementById('site-icon').dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return [dt.getData('text/uri-list'), dt.getData('text/html')];
  });
  assert.deepEqual(dragged, ['https://www.youtube.com/watch?v=abc', '<a href="https://www.youtube.com/watch?v=abc">YouTube</a>']);
  assert.deepEqual(errors, []);
});

// A WAV file: quiet, a second and a half of "speech" (a wavering tone), quiet.
function speechWav(file) {
  const rate = 16000;
  const sec = (s) => Math.round(s * rate);
  const samples = new Float32Array(sec(1) + sec(1.5) + sec(3));
  for (let i = 0; i < sec(1.5); i++) samples[sec(1) + i] = 0.35 * Math.sin(i * 2 * Math.PI * 180 / rate) * (0.6 + 0.4 * Math.sin(i / 900));
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2));
  fs.writeFileSync(file, buf);
}

test('voice mode: what you say is sent, and the answer is spoken sentence by sentence', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-voice-')), 'speech.wav');
  speechWav(wav);
  const { chromium } = require('playwright-core');
  const b = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const { page, errors } = await openShell(b, {
      'ai:voice-transcribe': { value: { text: 'What is this video about?' } },
      'ai:send': { value: { ok: true, chatId: 'c1' } },
      'ai:voice-speak': { value: { error: 'no audio in tests' } },
    });
    await page.click('#voice-btn');
    assert.equal(await page.isVisible('#voice-bar'), true, 'the voice dock replaces the chat box');
    assert.equal(await page.isVisible('#prompt'), false);
    // The microphone hears the phrase, it's turned into text and sent as a voice message.
    const ok = await page.waitForFunction(() => window.__calls.some(([c]) => c === 'ai:send'), null, { timeout: 15_000 }).then(() => true, () => false);
    if (!ok) {
      const why = await page.evaluate(() => ({ calls: window.__calls.map(([c]) => c), notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent), status: document.querySelector('.vb-status').textContent, level: getComputedStyle(document.getElementById('voice-bar')).getPropertyValue('--level'), voice: document.body.dataset.voice }));
      assert.fail(`nothing was sent: ${JSON.stringify(why)} ${JSON.stringify(errors)}`);
    }
    const [heard, sent] = await page.evaluate(() => [window.__calls.find(([c]) => c === 'ai:voice-transcribe')[1], window.__calls.find(([c]) => c === 'ai:send')[1]]);
    assert.equal(heard.mime, 'audio/wav');
    assert.ok(heard.seconds > 1 && heard.seconds < 3, `phrase of ${heard.seconds} s`);
    assert.deepEqual([sent.text, sent.voice], ['What is this video about?', true]);
    // The reply streams in; each finished sentence is read aloud right away.
    await page.evaluate(() => {
      const e = (ev) => window.__emit('ai-event', { chatId: 'c1', ...ev });
      e({ type: 'user', text: 'What is this video about?' });
      e({ type: 'start' });
      e({ type: 'text', delta: 'It shows how bikes ' });
      e({ type: 'text', delta: 'work. The gears' });
    });
    await page.waitForFunction(() => window.__calls.some(([c, a]) => c === 'ai:voice-speak' && a.text === 'It shows how bikes work.'));
    assert.equal(await page.evaluate(() => window.__calls.filter(([c]) => c === 'ai:voice-speak').length), 1, 'the unfinished sentence waits');
    await page.evaluate(() => window.__emit('ai-event', { chatId: 'c1', type: 'end' }));
    await page.click('#voice-bar .vb-end');
    assert.equal(await page.isVisible('#voice-bar'), false);
    assert.equal(await page.isVisible('#prompt'), true);
    assert.deepEqual(errors.filter((e) => !/no audio in tests/.test(e)), []);
  } finally {
    await b.close();
  }
});

test('dictation: what you said lands in the box, and when you send it the answer is read aloud', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-dictate-')), 'speech.wav');
  speechWav(wav);
  const { chromium } = require('playwright-core');
  const b = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const { page, errors } = await openShell(b, {
      'ai:voice-transcribe': { value: { text: 'What time is it in Tokyo?' } },
      'ai:send': { value: { ok: true, chatId: 'c7' } },
      // A real (tiny, silent) sound file, so playing it is tested too.
      'ai:voice-speak': { fn: `const n = 800; const b = new Uint8Array(44 + n * 2); const v = new DataView(b.buffer);
        const w = (o, s) => [...s].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
        window.__played = (window.__played || 0); return { audio: b };` },
    });
    await page.click('#mic-btn');
    await page.waitForFunction(() => document.getElementById('prompt').value === 'What time is it in Tokyo?', null, { timeout: 15_000 });
    // Sent: the reply is spoken as it streams.
    await page.evaluate(() => {
      const e = (ev) => window.__emit('ai-event', { chatId: 'c7', ...ev });
      e({ type: 'user', text: 'What time is it in Tokyo?' });
      e({ type: 'start' });
      e({ type: 'text', delta: 'It is 9 in the morning in Tokyo. ' });
      e({ type: 'text_end' });
      e({ type: 'end' });
    });
    await page.waitForFunction(() => window.__calls.some(([c, a]) => c === 'ai:voice-speak' && /9 in the morning/.test(a.text)), null, { timeout: 5000 });
    await page.waitForTimeout(800);
    assert.deepEqual(await page.$$eval('.notice', (els) => els.map((e) => e.textContent).filter((t) => /voice/i.test(t))), [], 'the voice played (no “couldn’t play”)');
    // A typed message stays silent.
    const before = await page.evaluate(() => window.__calls.filter(([c]) => c === 'ai:voice-speak').length);
    await page.evaluate(() => {
      const e = (ev) => window.__emit('ai-event', { chatId: 'c7', ...ev });
      e({ type: 'user', text: 'and in Paris?' });
      e({ type: 'start' });
      e({ type: 'text', delta: 'It is 2 in the morning in Paris. ' });
      e({ type: 'end' });
    });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__calls.filter(([c]) => c === 'ai:voice-speak').length), before, 'typed: no voice');
    assert.deepEqual(errors.filter((e) => !/no audio in tests/.test(e)), []);
  } finally {
    await b.close();
  }
});

test('workflows: / lists them, the card asks for blanks, and Run sends it', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openShell(browser, {
    'shell:init': { value: { ...INIT, ai: { ...AI, workflows: true } } },
    'ai:workflows': { value: [
      { id: 'w1', title: 'Price check', description: '', instructions: 'Check the price of {item}.', inputs: [{ name: 'item', label: 'Product' }], runs: 0 },
      { id: 'w2', title: 'Morning news', description: 'Top stories', instructions: 'Read the news.', inputs: [], runs: 2 },
    ] },
    'ai:send': { value: { ok: true, chatId: 'c5' } },
  });
  await page.fill('#prompt', '/pri');
  assert.equal(await page.isVisible('#wf-menu'), true);
  assert.deepEqual(await page.$$eval('#wf-menu .menu-row b', (els) => els.map((e) => e.textContent)), ['Price check']);
  await page.press('#prompt', 'Enter');
  assert.equal(await page.inputValue('#prompt'), '', 'the / text is cleared');
  assert.equal(await page.isVisible('#wf-card'), true);
  await page.fill('#wf-card input', 'AirPods Pro');
  await page.press('#wf-card input', 'Enter');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'ai:send'));
  const sent = await page.evaluate(() => window.__calls.find(([c]) => c === 'ai:send')[1]);
  assert.deepEqual(sent.workflow, { id: 'w1', values: { item: 'AirPods Pro' } });
  assert.equal(await page.isVisible('#wf-card'), false);
  // From the new tab page or Settings, main asks the panel to open one.
  await page.evaluate(() => window.__emit('ai-workflow', { id: 'w2' }));
  await page.waitForFunction(() => window.__calls.filter(([c]) => c === 'ai:send').length === 2, null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(([c]) => c === 'ai:send')[1][1].workflow), { id: 'w2', values: {} }, 'no blanks: it runs right away');
  assert.deepEqual(errors, []);
});

test('the sidebar: templates, recents, projects, the chat menu, search, hide and show', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openShell(browser, {
    'shell:init': { value: { ...INIT, ai: { ...AI, workflows: true }, sidebar: { open: true, getStarted: true } } },
    'ai:projects': { value: [{ id: 'p1', name: 'Mom’s birthday', instructions: 'Budget $800, Miami' }] },
    'ai:chats': { value: [{ id: 'c2', title: 'Cake ideas', updatedAt: Date.now() - 60_000, projectId: 'p1' }, { id: 'c1', title: 'Trip to Lisbon', updatedAt: Date.now() - 3_600_000, projectId: null }] },
    'ai:workflows': { value: [{ id: 'w1', title: 'Price check', description: '', instructions: 'Check {item}.', inputs: [{ name: 'item', label: 'Item' }] }] },
    'ai:schedules': { value: [{ id: 's1', title: 'Morning news', when: 'Every day at 8:00 AM', nextRun: Date.now() + 3_600_000 }] },
    'ai:chat': { fn: "return { id: args[0], title: 'Trip to Lisbon', display: [{ kind: 'user', text: 'Plan it' }, { kind: 'ai', text: 'Day 1: Alfama' }], projectId: null }" },
    'ai:chat-search': { value: [{ id: 'c1', title: 'Trip to Lisbon', snippet: '…Lisbon in June' }] },
    'ai:chat-move': { value: { ok: true } },
    'ai:send': { value: { ok: true, chatId: 'c9' } },
  });
  await page.waitForSelector('#sb-recents [data-chat]');
  assert.equal(await page.isVisible('#sidebar'), true);
  assert.deepEqual(await page.$$eval('#sb-recents .sb-t', (els) => els.map((e) => e.textContent)), ['Cake ideas', 'Trip to Lisbon']);
  assert.match(await page.textContent('#sb-projects'), /Mom’s birthday/);
  assert.match(await page.textContent('#sb-start'), /Get started/);
  if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'sidebar-1.png') });

  // Templates fill in the chat box with the blank selected.
  await page.click('[data-sec="templates"]');
  await page.click('[data-tpl="0"]');
  const sel = await page.evaluate(() => { const p = document.getElementById('prompt'); return p.value.slice(p.selectionStart, p.selectionEnd); });
  assert.equal(sel, '[product]');

  // A recent chat opens in the panel and is highlighted.
  await page.click('[data-chat="c1"]');
  await page.waitForFunction(() => document.querySelector('[data-chat="c1"]')?.classList.contains('on'));
  assert.match(await page.textContent('#messages'), /Day 1: Alfama/);

  // A project lists its chats; New task there starts in it.
  await page.click('[data-project="p1"]');
  assert.deepEqual(await page.$$eval('#sb-recents .sb-t', (els) => els.map((e) => e.textContent)), ['Cake ideas']);
  assert.match(await page.textContent('#sb-recents-label'), /Mom’s birthday/);
  await page.click('#sb-new');
  assert.match(await page.textContent('#project-btn'), /Mom’s birthday/);
  await page.fill('#prompt', 'find a bakery');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'ai:send'));
  assert.equal(await page.evaluate(() => window.__calls.find(([c]) => c === 'ai:send')[1].projectId), 'p1');
  await page.click('#sb-back');

  // The chat menu moves a chat into a project.
  await page.hover('[data-chat="c1"]');
  await page.click('[data-cmenu="c1"]');
  await page.click('#sb-menu [data-act="move"][data-arg="p1"]');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'ai:chat-move'));

  // Search.
  await page.click('#sb-search-btn');
  await page.fill('#sb-q', 'lisbon');
  await page.waitForSelector('#sb-results [data-chat="c1"]');
  assert.match(await page.textContent('#sb-results'), /Lisbon in June/);
  if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'sidebar-2.png') });

  // Hide and show.
  await page.click('#sb-close');
  assert.equal(await page.isVisible('#sidebar'), false);
  assert.equal(await page.isVisible('#sb-open'), true);
  assert.deepEqual(await page.evaluate(() => window.__sent.filter(([c]) => c === 'sidebar:set').at(-1)), ['sidebar:set', { open: false }]);
  await page.click('#sb-open');
  assert.equal(await page.isVisible('#sidebar'), true);
  assert.deepEqual(errors, []);
});

// Light and dark: what the window's colors are checked on.
const TOKENS = ['--bg', '--panel', '--card', '--text', '--dim', '--label'];
const PARTS = ['body', '#tabstrip', '#toolbar', '#omnibox', '#sidebar', '#panel', '#composer'];
const rgbOf = (hex) => hex.slice(1).match(/../g).map((h) => parseInt(h, 16));
// --accent as JS reads it, and what it reads for each profile theme color.
const readAccents = (page) => page.evaluate(async () => {
  const root = document.documentElement;
  const read = () => getComputedStyle(root).getPropertyValue('--accent').trim();
  const accent = read();
  const { THEME_COLORS, setAccent } = await import('/assets/theme-colors.js');
  const each = {};
  for (const [id, c] of Object.entries(THEME_COLORS)) { setAccent(root, c); each[id] = read(); }
  return { accent, each };
});

test('light and dark: the window follows the computer, text stays readable, incognito stays dark', { skip: !CHROME && 'Google Chrome not installed' }, async (t) => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors } = await openShell(browser, {}, { colorScheme: scheme });
    const c = await readColors(page, { tokens: TOKENS, parts: PARTS });
    const { accent, each } = await readAccents(page);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `shell-${scheme}.png`) });
    await page.close();
    assert.deepEqual(errors, [], `no errors in ${scheme}`);
    for (const [part, rgb] of Object.entries(c.parts)) {
      assert.ok(scheme === 'light' ? luminance(rgb) > 0.7 : luminance(rgb) < 0.05, `${part} is ${scheme} (rgb ${rgb})`);
    }
    // Normal text needs 4.5:1 (WCAG AA). All pairs are listed at once when some fail.
    const low = [];
    for (const text of ['--text', '--dim', '--label']) {
      for (const surface of ['--bg', '--panel', '--card']) {
        const ratio = contrast(c.tokens[text], c.tokens[surface]);
        if (ratio < 4.5) low.push(`${text} on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
    assert.deepEqual(low, [], `${scheme}: text below 4.5:1`);
    // JS and the e2e tests read --accent back, so it must stay a plain color, whatever the theme color.
    for (const hex of [accent, ...Object.values(each)]) assert.match(hex, /^#[0-9a-f]{6}$/i);
    if (scheme === 'light') {
      // Accents are links, icons and focus rings: at least 3:1 on the background.
      for (const [id, hex] of Object.entries(each)) assert.ok(contrast(rgbOf(hex), c.tokens['--bg']) >= 3, `${id} accent on light: ${contrast(rgbOf(hex), c.tokens['--bg']).toFixed(2)}:1`);
    }
  }

  // An incognito window on a light computer: served dark, so it's dark from the first paint, with the purple accent.
  const { page, errors } = await openShell(browser, { 'shell:init': { value: { ...INIT, incognito: true } } }, { colorScheme: 'light', query: '?appearance=dark' });
  const c = await readColors(page, { tokens: TOKENS, parts: PARTS });
  const { accent } = await readAccents(page);
  await page.close();
  assert.deepEqual(errors, []);
  for (const [part, rgb] of Object.entries(c.parts)) assert.ok(luminance(rgb) < 0.05, `incognito ${part} is dark (rgb ${rgb})`);
  assert.equal(accent, '#b58cff');
  assert.ok(contrast(c.tokens['--text'], c.tokens['--bg']) >= 4.5);
});

test('the address bar selects its text when it gets focus, but a quick Tab past it keeps going', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openShell(browser);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => document.getElementById('address').focus());
  await frames();
  assert.deepEqual(await page.evaluate(() => { const a = document.getElementById('address'); return [a.value, a.selectionStart, a.selectionEnd === a.value.length]; }), ['https://www.youtube.com/watch?v=abc', 0, true], 'all of it, ready to type over');
  await page.evaluate(() => { document.getElementById('address').blur(); document.getElementById('address').focus(); document.getElementById('prompt').focus(); });
  await frames();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt', 'not pulled back to the address bar');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the address bar says "Not secure" in red on a site whose certificate warning you went past', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors } = await openShell(browser, {}, { colorScheme: scheme });
    const icon = () => page.$eval('#site-icon', (el) => ({ text: el.textContent, danger: el.classList.contains('danger'), clickable: el.classList.contains('clickable') }));
    assert.deepEqual(await icon(), { text: '', danger: false, clickable: true }, 'a normal https page: the lock');
    await page.evaluate(() => window.__emit('tabs', { activeId: 1, tabs: [{ id: 1, title: 'Bad cert', url: 'https://self-signed.example/', notSecure: true }] }));
    assert.deepEqual(await icon(), { text: 'Not secure', danger: true, clickable: true });
    const c = await readColors(page, { tokens: ['--danger-text'], parts: ['#omnibox'] });
    assert.ok(contrast(c.tokens['--danger-text'], c.parts['#omnibox']) >= 4.5, `${scheme}: red on the address bar ${contrast(c.tokens['--danger-text'], c.parts['#omnibox']).toFixed(2)}:1`);
    // It opens the site information, like the lock.
    await page.click('#site-icon');
    assert.ok(await page.evaluate(() => window.__calls.some(([c]) => c === 'site:info')));
    await page.close();
    assert.deepEqual(errors, []);
  }
});

test('the address bar shows "Pop-up blocked" when the page’s pop-ups were blocked, and lists them', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const info = { host: 'www.youtube.com', allowed: false, items: [{ id: 1, url: 'https://ads.example/' }] };
  const { page, errors } = await openShell(browser, { 'site:popups': { value: info } });
  const tabs = (n, id = 1) => page.evaluate(([count, tid]) => window.__emit('tabs', { activeId: tid, tabs: [{ id: tid, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc', popupsBlocked: count }] }), [n, id]);
  assert.equal(await page.isVisible('#popups-btn'), false, 'nothing blocked: no icon');
  await tabs(1);
  assert.equal(await page.isVisible('#popups-btn'), true);
  assert.equal(await page.isVisible('#popups-btn .label'), true, 'a new one: the words for a moment');
  assert.equal(await page.getAttribute('#popups-btn', 'aria-label'), 'Pop-ups were blocked on this page');
  // Another tab with blocked ones shows the icon, without the words.
  await tabs(2, 7);
  assert.equal(await page.isVisible('#popups-btn .label'), false);
  await tabs(1);
  await page.click('#popups-btn');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:show'));
  const shown = await page.evaluate(() => window.__sent.find(([c]) => c === 'overlay:show')[1].payload);
  assert.deepEqual(shown, { kind: 'popups', focus: true, ...info });
  // Clicking it again closes the list.
  await page.click('#popups-btn');
  assert.deepEqual(await page.evaluate(() => window.__sent.at(-1)), ['overlay:hide', 'popups']);
  await page.close();
  assert.deepEqual(errors, []);
});

test('toolbar: history menus, new-tab clicks, Home, the mouse’s buttons, the zoom badge and a find bar per tab', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openShell(browser);
  const sent = (channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
  const POLL = { polling: 50 };
  const tabs = (activeId, extra = {}) => page.evaluate(([id, more]) => window.__emit('tabs', { activeId: id, tabs: [
    { id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc', canGoBack: true, canGoForward: true, ...more[1] },
    { id: 2, title: 'News', url: 'https://news.example/', canGoBack: true, canGoForward: false, ...more[2] },
  ] }), [activeId, extra]);
  await tabs(1);

  // Right-click Back: this tab's history, just under the button.
  await page.click('#back', { button: 'right' });
  const back = await page.evaluate(() => document.getElementById('back').getBoundingClientRect().toJSON());
  const [menu] = await sent('tab:history-menu');
  assert.equal(menu.dir, 'back');
  assert.ok(menu.x === back.left && menu.y >= back.bottom, JSON.stringify(menu));
  // Holding Forward down opens its menu; letting go doesn't also go forward.
  const f = await page.$eval('#forward', (el) => el.getBoundingClientRect().toJSON());
  await page.mouse.move(f.left + 8, f.top + 8);
  await page.mouse.down();
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'tab:history-menu' && p.dir === 'forward'), null, { ...POLL, timeout: 15_000 });
  await page.mouse.up();
  assert.deepEqual(await sent('tab:forward'), []);
  // Middle-click and ⌘/Ctrl-click open in a new tab; Shift-click in a new window; a plain click goes back.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.click('#back', { button: 'middle' });
  await page.click('#reload', { modifiers: [mod] });
  await page.click('#forward', { modifiers: [mod, 'Shift'] });
  await page.click('#back', { modifiers: ['Shift'] });
  assert.deepEqual(await sent('tab:nav-new'), [
    { which: 'back', disposition: 'background' },
    { which: 'reload', disposition: 'background' },
    { which: 'forward', disposition: 'foreground' },
    { which: 'back', disposition: 'window' },
  ]);
  assert.deepEqual([await sent('tab:back'), await sent('tab:reload')], [[], []], 'not also in this tab');
  await page.click('#back');
  assert.equal((await sent('tab:back')).length, 1);
  // The mouse's own back and forward buttons, over the browser's UI (on Linux Electron does it).
  if (process.platform !== 'linux') {
    await page.evaluate(() => {
      document.getElementById('toolbar').dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true }));
      document.getElementById('tabs').dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true }));
    });
    assert.equal((await sent('tab:back')).length, 2);
    assert.equal((await sent('tab:forward')).length, 1);
  }

  // Home: off by default; Settings turns it on, next to Reload.
  assert.equal(await page.isVisible('#home'), false);
  await page.evaluate(() => window.__emit('nav-prefs', { showHome: true, homeUrl: 'lumio://newtab/' }));
  assert.equal(await page.evaluate(() => document.getElementById('reload').nextElementSibling.id), 'home');
  await page.click('#home');
  await page.click('#home', { button: 'middle' });
  assert.deepEqual(await sent('tab:home'), [{ disposition: 'current' }, { disposition: 'background' }]);

  // The zoom badge follows the tab you're on.
  await tabs(1, { 1: { zoom: 125 } });
  assert.equal(await page.textContent('#zoom-badge'), '125%');
  await tabs(2, { 1: { zoom: 125 } });
  assert.equal(await page.isVisible('#zoom-badge'), false);
  // Zooming shows the bubble for a moment; clicking the badge keeps it open.
  await page.evaluate(() => window.__emit('zoom', { level: 110, zoomed: true }));
  assert.equal(await page.textContent('#zoom-badge'), '110%');
  let shown = (await sent('overlay:show')).at(-1);
  assert.deepEqual([shown.payload.kind, shown.payload.percent, shown.payload.auto], ['zoom', 110, true]);
  const badge = await page.$eval('#zoom-badge', (el) => el.getBoundingClientRect().toJSON());
  assert.ok(shown.rect.y > badge.bottom && shown.rect.x + shown.rect.width > badge.right, 'under the badge');
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'zoom' })); // it closed itself
  await tabs(2, { 2: { zoom: 110 } });
  await page.click('#zoom-badge');
  shown = (await sent('overlay:show')).at(-1);
  assert.deepEqual([shown.payload.kind, shown.payload.auto], ['zoom', false]);
  await page.click('#zoom-badge');
  assert.equal((await sent('overlay:hide')).at(-1), 'zoom', 'a second click closes it');

  // Find: each tab keeps its own bar and words.
  await tabs(1);
  await page.evaluate(() => window.__emit('find-open'));
  await page.fill('#find-input', 'needle');
  await page.evaluate(() => window.__emit('find-result', { matches: 3, activeMatchOrdinal: 1 }));
  const searches = (await sent('find:start')).length;
  await page.evaluate(() => window.__emit('find-close')); // main: another tab is about to show
  await tabs(2);
  assert.equal(await page.isVisible('#findbar'), false);
  await page.evaluate(() => window.__emit('find-close'));
  await tabs(1);
  await page.waitForFunction(() => !document.getElementById('findbar').hidden, null, POLL);
  assert.deepEqual([await page.inputValue('#find-input'), await page.textContent('#find-count')], ['needle', '1/3']);
  assert.equal((await sent('find:start')).length, searches, 'no new search: the highlights are still there');
  // ⌘E: the selection becomes the search.
  await page.evaluate(() => window.__emit('find-text', { text: 'thread' }));
  assert.equal(await page.inputValue('#find-input'), 'thread');
  assert.deepEqual((await sent('find:start')).at(-1), { text: 'thread' });
  // Closed in this tab: it stays closed when you come back.
  await page.click('#find-close');
  await page.evaluate(() => window.__emit('find-close'));
  await tabs(2);
  await page.evaluate(() => window.__emit('find-close'));
  await tabs(1);
  assert.equal(await page.isVisible('#findbar'), false);
  assert.deepEqual(errors, []);
});
