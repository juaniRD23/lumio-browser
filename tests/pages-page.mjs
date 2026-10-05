// Lumio's own pages (renderer/pages) in headless Chrome with a stand-in
// browser, for tests that drive them (tests/pages-motion.test.mjs).
// window.__calls records what a page asked for; window.__emit(channel,
// payload) plays a message from the browser; window.__answers can be changed
// while it runs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

export async function startPagesServer() {
  const server = http.createServer((req, res) => {
    const file = resolveFile(new URL(`lumio://newtab${req.url}`), PAGE_HOSTS);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function openInternal(browser, base, name, { answers = {}, colorScheme, reducedMotion, viewport = { width: 1100, height: 800 }, query = '' } = {}) {
  const page = await browser.newPage({ viewport, colorScheme, reducedMotion });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript((answers) => {
    const handlers = {};
    window.__calls = [];
    window.__answers = answers;
    window.__last = performance.now();
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    window.lumioPage = {
      invoke: async (channel, ...args) => {
        window.__calls.push([channel, ...args]);
        window.__last = performance.now();
        const a = window.__answers[channel];
        return structuredClone(typeof a === 'function' ? a(...args) : a ?? null);
      },
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); },
    };
  }, answers);
  await page.goto(`${base}/${name}.html${query}`);
  await page.waitForFunction(() => performance.now() - window.__last > 150);
  return { page, errors };
}
