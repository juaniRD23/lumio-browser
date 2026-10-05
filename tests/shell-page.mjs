// The window's UI (renderer/ui) in headless Chrome, with a stand-in for the
// main process, for tests that drive it: tests/motion.test.mjs and
// tests/popovers-ui.test.mjs. Skipped when Google Chrome isn't installed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');

export const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

// What the main process answers while the window starts (see main.js shell:init).
export const AI = { ready: true, lumio: { signedIn: true, plan: 'free', usage: { used: 0.38, fullAt: Date.now() + 864e5 } }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], mode: 'ask', running: false, vision: true, macAvailable: true };
export const tab = (id, extra = {}) => ({ id, title: `Page ${id}`, url: `https://site${id}.example/`, favicon: null, loading: false, canGoBack: false, canGoForward: false, pinned: false, pdf: false, ...extra });
export const INIT = {
  tabs: { activeId: 1, tabs: [tab(1)] },
  downloads: [], panel: { open: false, width: 380 }, sidebar: { open: false }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'Test Person', email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.3', update: null,
};

// Serves renderer/ui as lumio://shell does, with the app's real Content-Security-Policy.
export async function startServer() {
  const server = http.createServer((req, res) => {
    const file = resolveFile(new URL(`lumio://shell${req.url}`), new Set(['shell']));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Opens a UI page (the window, or overlay.html) with a stand-in main process:
// window.__sent records what it sends, window.__emit(channel, payload) plays
// what main would send. init replaces shell:init's answer; answers adds
// answers to other invoke() calls.
export async function openPage(browser, base, { file = '', init = INIT, answers = {}, colorScheme, reducedMotion, viewport = { width: 1280, height: 800 } } = {}) {
  const page = await browser.newPage({ viewport, colorScheme, reducedMotion });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ init, ai, more }) => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] }, ...more };
    window.lumio = {
      invoke: async (channel) => answers[channel] ?? null,
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { init, ai: AI, more: answers });
  await page.goto(`${base}/${file}`);
  if (!file) await page.waitForFunction(() => document.querySelector('.tab') && !document.body.classList.contains('no-anim'), null, { timeout: 10_000 });
  return { page, errors };
}

// Plays the page's animations at a fraction of their speed, so there are
// frames in the middle of them to sample even on a busy machine.
export async function slowMotion(page, rate = 0.25) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
}

// Samples fn() in the page every frame for `ms` (passed as source: the
// page's CSP doesn't allow building functions from strings).
export const sample = (page, fn, ms = 400) => page.evaluate(`(async () => {
  const f = ${fn.toString()};
  const out = [];
  const end = performance.now() + ${ms};
  while (performance.now() < end) { out.push(f()); await new Promise((r) => requestAnimationFrame(r)); }
  return out;
})()`);
