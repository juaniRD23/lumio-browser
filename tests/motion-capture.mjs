// Motion and visual QA (run by hand: node tests/motion-capture.mjs). Drives
// the window, the overlay and Lumio's pages in headless Chrome and saves:
//  - dist/motion-shots/<moment>-<n>.png: frames during each animation
//    (played at a fifth of their speed so there are frames in the middle);
//  - dist/batch3-shots/<what>-<light|dark>.png: the new UI in both themes;
//  - dist/motion-report.json: frame times while things move (the longest
//    gap between frames), whether Reduce Motion leaves anything moving, and
//    the CSS transitions that animate layout (width, height, top, left,
//    margin, padding) instead of transform and opacity.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { CHROME, INIT, tab, startServer, openPage, slowMotion } from './shell-page.mjs';
import { startPagesServer, openInternal } from './pages-page.mjs';
const require = createRequire(import.meta.url);
const { buildBrowserMenu, menuModel } = require('../main/menu.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOTION = path.join(ROOT, 'dist', 'motion-shots');
const SHOTS = path.join(ROOT, 'dist', 'batch3-shots');
fs.mkdirSync(MOTION, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
if (!CHROME) { console.log('Google Chrome is not installed'); process.exit(0); }

const { server, base } = await startServer();
const pages = await startPagesServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { frames: {}, reduced: {}, layoutTransitions: [], moments: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (page, ch, payload) => page.evaluate(([c, p]) => window.__emit(c, p), [ch, payload]);
const overlay = (page, p) => emit(page, 'overlay-data', p);
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const now = Date.now();

// Frames of one moment: act() starts it, then n screenshots ~150 ms apart
// (at a fifth of the speed: every ~30 ms of the real animation).
async function capture(page, moment, act, { n = 5, every = 150, clip, rate = 0.2 } = {}) {
  await slowMotion(page, rate);
  await act();
  for (let i = 1; i <= n; i++) {
    await page.screenshot({ path: path.join(MOTION, `${moment}-${i}.png`), clip });
    await wait(every);
  }
  await slowMotion(page, 1);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  report.moments.push(moment);
}

// The longest gap between frames while act() runs and for `ms` after it.
async function frameGaps(page, name, act, ms = 700) {
  await page.evaluate(() => {
    window.__gaps = [];
    let last = performance.now();
    const tick = (t) => { window.__gaps.push(t - last); last = t; if (window.__gapsOn) requestAnimationFrame(tick); };
    window.__gapsOn = true;
    requestAnimationFrame(tick);
  });
  await act();
  await wait(ms);
  const gaps = await page.evaluate(() => { window.__gapsOn = false; return window.__gaps.slice(1); });
  const sorted = [...gaps].sort((a, b) => a - b);
  report.frames[name] = { frames: gaps.length, max: Math.round(sorted.at(-1) || 0), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0) };
}

const menuItems = () => menuModel(buildBrowserMenu(new Proxy({ isDev: false }, { get: (t, k) => (k in t ? t[k] : () => {}) }), {
  zoom: 100, recentlyClosed: [{ label: 'News', index: 0, favicon: PIXEL }], bookmarks: [{ url: 'https://a.example/', title: 'A bookmark' }], open() {}, edit() {},
}), { mac: true }).items;

const POPOVERS = {
  suggest: { width: 640, height: 230, payload: { kind: 'suggest', query: 'git', selected: 0, items: [{ type: 'search', title: 'git', url: 'https://s.example/?q=git' }, { type: 'history', title: 'GitHub', url: 'https://github.com/', favicon: PIXEL }, { type: 'bookmark', title: 'Git tips', url: 'https://tips.example/' }, { type: 'ai', title: 'git' }] } },
  downloads: { width: 384, height: 240, payload: { kind: 'downloads', items: [{ id: 'd1', name: 'report.pdf', url: 'https://e.example/r.pdf', state: 'progressing', received: 4e6, total: 1e7 }, { id: 'd2', name: 'photo.png', state: 'completed', total: 2e6 }], origin: { x: 360, y: -20 } } },
  siteinfo: { width: 360, height: 300, payload: { kind: 'siteinfo', info: { host: 'github.com', secure: true, permissions: [{ label: 'Camera', permission: 'media', value: undefined }, { label: 'Notifications', permission: 'notifications', value: true }] }, origin: { x: 16, y: -20 } } },
  account: { width: 344, height: 420, payload: { kind: 'account', account: { signedIn: true, name: 'Ana', email: 'ana@lumio.test', planName: 'Pro' }, profile: {}, origin: { x: 310, y: -20 } } },
  pwsave: { width: 380, height: 260, payload: { kind: 'pwsave', prompt: { id: 1, host: 'github.com', username: 'ana', length: 12 }, origin: { x: 340, y: -20 } } },
  passkey: { width: 380, height: 240, payload: { kind: 'passkey', prompt: { id: 2, mode: 'create', rpId: 'github.com', user: { userName: 'ana' }, accounts: [] } } },
  update: { width: 380, height: 300, payload: { kind: 'update', update: { latest: '0.7.0', current: '0.6.7', status: 'available', notes: '- Faster tabs\n- New menu' }, origin: { x: 340, y: -20 } } },
  screenshare: { width: 420, height: 320, payload: { kind: 'screenshare', share: { id: 3, host: 'meet.example', sources: [{ id: 's1', name: 'Entire screen', screen: true }, { id: 'w1', name: 'Notes' }] } } },
  hovercard: { width: 900, height: 300, payload: { kind: 'hovercard', id: 2, x: 220, title: 'GitHub: where the world builds software', site: 'github.com', shot: true, preview: PIXEL } },
};

try {
  // ---------------------------------------------------------------- window: tabs
  {
    const { page } = await openPage(browser, base, { init: { ...INIT, tabs: { activeId: 1, tabs: [tab(1), tab(2), tab(3)] } }, viewport: { width: 1100, height: 700 } });
    const clip = { x: 0, y: 0, width: 1100, height: 90 };
    await capture(page, 'tab-open', () => emit(page, 'tabs', { activeId: 4, tabs: [tab(1), tab(2), tab(3), tab(4)] }), { clip });
    await capture(page, 'tab-close', () => emit(page, 'tabs', { activeId: 3, tabs: [tab(1), tab(2), tab(3)] }), { clip });
    await capture(page, 'tab-reorder', () => emit(page, 'tabs', { activeId: 3, tabs: [tab(3), tab(1), tab(2)] }), { clip });
    await capture(page, 'find-bar', () => emit(page, 'find-open'), { clip });
    await capture(page, 'permission-bar', () => emit(page, 'permission', { id: 1, host: 'meet.example', label: 'use your camera' }), { clip: { x: 0, y: 0, width: 1100, height: 160 } });
    await capture(page, 'toast', () => emit(page, 'toast', { text: 'Bookmarked' }), { clip });
    await capture(page, 'load-progress', () => emit(page, 'tabs', { activeId: 3, tabs: [tab(3, { loading: true }), tab(1), tab(2)] }), { clip, n: 4, every: 300 });
    await frameGaps(page, 'tab open', () => emit(page, 'tabs', { activeId: 5, tabs: [tab(3), tab(1), tab(2), tab(5)] }));
    await frameGaps(page, 'tab close', () => emit(page, 'tabs', { activeId: 3, tabs: [tab(3), tab(1), tab(2)] }));
    await page.close();
  }

  // ---------------------------------------------------------------- overlay: every popover in and out
  {
    const { page } = await openPage(browser, base, { file: 'overlay.html', viewport: { width: 640, height: 440 } });
    let seq = 0;
    for (const [name, p] of Object.entries(POPOVERS)) {
      seq++;
      const s = seq;
      await overlay(page, { ...p.payload, op: 'show', seq: s, width: p.width, height: p.height });
      await capture(page, `popover-${name}-in`, () => overlay(page, { op: 'in', seq: s }), { n: 4 });
      seq++;
      await capture(page, `popover-${name}-out`, () => overlay(page, { op: 'out', seq: seq }), { n: 3 });
    }
    await frameGaps(page, 'popover open', async () => {
      await overlay(page, { ...POPOVERS.account.payload, op: 'show', seq: 100, width: 344, height: 420 });
      await overlay(page, { op: 'in', seq: 100 });
    });
    await page.close();
  }
  {
    const { page } = await openPage(browser, base, { file: 'overlay.html', viewport: { width: 1100, height: 700 } });
    await overlay(page, { kind: 'menu', items: menuItems(), at: { right: 1090, top: 78 }, origin: { x: 1075, y: 60 }, width: 1100, height: 700, op: 'show', seq: 1 });
    await capture(page, 'menu-in', () => overlay(page, { op: 'in', seq: 1 }), { n: 4 });
    await overlay(page, { op: 'key', key: 'h' });
    await overlay(page, { op: 'key', key: 'h' });
    await capture(page, 'menu-submenu', () => overlay(page, { op: 'key', key: 'ArrowRight' }), { n: 4 });
    await capture(page, 'menu-out', () => overlay(page, { op: 'out', seq: 2 }), { n: 3 });
    await page.close();
  }

  // ---------------------------------------------------------------- AI panel: streaming
  {
    const { page } = await openPage(browser, base, { init: { ...INIT, panel: { open: true, width: 380 } }, answers: { 'ai:chat': { id: 'c1', display: [{ kind: 'user', text: 'Hi' }, { kind: 'ai', text: 'Hello! How can I help?' }] } }, viewport: { width: 1100, height: 700 } });
    await emit(page, 'ai-open-chat', { id: 'c1' });
    await page.waitForSelector('.msg.ai');
    const clip = { x: 1100 - 400, y: 80, width: 400, height: 620 };
    await capture(page, 'ai-message-in', async () => {
      await emit(page, 'ai-event', { type: 'user', chatId: 'c1', text: 'Plan a 3-day trip to Rome' });
      await emit(page, 'ai-event', { type: 'start', chatId: 'c1' });
      await emit(page, 'ai-event', { type: 'step', chatId: 'c1', id: 's1', name: 'web_search', label: 'Searching the web', icon: 'search' });
    }, { clip, n: 4 });
    await capture(page, 'ai-step-done', () => emit(page, 'ai-event', { type: 'step_done', chatId: 'c1', id: 's1', status: 'ok' }), { clip, n: 4 });
    const words = ('Here is a plan for **three days in Rome**.\n\n## Day 1\n\n- Colosseum and the Forum\n- Dinner in Monti\n\n## Day 2\n\n- Vatican Museums\n- Sunset at the Pincio\n\n' + 'More details follow as the answer keeps going. '.repeat(30)).split(/(?<= )/);
    await frameGaps(page, 'AI streaming', async () => {
      for (const w of words) { await emit(page, 'ai-event', { type: 'text', chatId: 'c1', delta: w }); }
    }, 300);
    await page.screenshot({ path: path.join(MOTION, 'ai-streaming-1.png'), clip });
    // Scrolled up while it writes: the Jump to latest pill.
    await page.$eval('#messages', (m) => { m.scrollTop = 0; });
    await wait(50);
    await emit(page, 'ai-event', { type: 'text', chatId: 'c1', delta: '\n\nOne more paragraph arrives while you read above.' });
    await wait(400);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: path.join(SHOTS, `jump-to-latest-${scheme}.png`), clip });
    }
    await page.close();
  }

  // ---------------------------------------------------------------- light and dark: the new UI
  for (const scheme of ['light', 'dark']) {
    {
      const { page } = await openPage(browser, base, { file: 'overlay.html', colorScheme: scheme, viewport: { width: 1100, height: 640 } });
      await overlay(page, { kind: 'menu', items: menuItems(), at: { right: 1090, top: 20 }, origin: { x: 1075, y: 4 }, width: 1100, height: 640, op: 'show', seq: 1 });
      await overlay(page, { op: 'in', seq: 1 });
      for (const k of ['b', 'ArrowRight']) await overlay(page, { op: 'key', key: k });
      await wait(500);
      await page.screenshot({ path: path.join(SHOTS, `menu-submenu-${scheme}.png`) });
      await page.close();
    }
    {
      const { page } = await openPage(browser, base, { file: 'overlay.html', colorScheme: scheme, viewport: { width: 640, height: 300 } });
      await overlay(page, { ...POPOVERS.hovercard.payload, op: 'show', seq: 1, width: 640, height: 300 });
      await overlay(page, { op: 'in', seq: 1 });
      await wait(400);
      await page.screenshot({ path: path.join(SHOTS, `hover-card-${scheme}.png`) });
      await page.close();
    }
    {
      const { page } = await openPage(browser, base, { colorScheme: scheme, init: { ...INIT, tabs: { activeId: 1, tabs: [tab(1, { loading: true }), tab(2)] } }, viewport: { width: 1100, height: 200 } });
      await wait(700);
      await page.screenshot({ path: path.join(SHOTS, `progress-bar-${scheme}.png`), clip: { x: 0, y: 0, width: 1100, height: 100 } });
      await page.close();
    }
    for (const bg of ['none', 'aurora', 'dusk', 'meadow']) {
      const { page } = await openInternal(browser, pages.base, 'newtab', {
        colorScheme: scheme,
        answers: { 'page:newtab-data': { topSites: [{ url: 'https://github.com/', title: 'GitHub' }], bookmarks: [], engine: 'Google', aiReady: true, name: 'Ana', chats: [{ id: 'c1', title: 'Trip to Rome', updatedAt: now - 3600e3 }] }, 'page:customize': { background: bg, shortcuts: true, recent: true, image: null, appearance: 'system', theme: 'blue' } },
      });
      await page.click('#cz-open');
      await wait(500);
      await page.screenshot({ path: path.join(SHOTS, `customize-${bg}-${scheme}.png`) });
      await page.close();
    }
    {
      const { page } = await openInternal(browser, pages.base, 'settings', {
        colorScheme: scheme,
        answers: {
          'page:settings': { account: { signedIn: false }, profile: { name: '', color: '#86b7ff', theme: 'blue' }, startup: 'newtab', platform: 'darwin', searchEngine: 'google', engines: [], approvalMode: 'ask', appearance: 'system', ai: {}, version: '0.6.7', importSources: [], sitePermissions: [] },
          'page:sync': { on: false, types: {}, requests: [] }, 'page:schedules': { tasks: [] }, 'page:workflows': { workflows: [] }, 'page:site-tips': { sites: [] },
          'page:accessibility': { focusRing: true, reduceMotion: false, largerText: false },
        },
      });
      await page.click('.side a[href="#accessibility"]');
      await wait(900);
      await page.screenshot({ path: path.join(SHOTS, `settings-accessibility-${scheme}.png`) });
      await page.close();
    }
  }

  // ---------------------------------------------------------------- pages: motion
  {
    const answers = { 'page:newtab-data': { topSites: [{ url: 'https://github.com/', title: 'GitHub' }], bookmarks: [], engine: 'Google', aiReady: true, name: 'Ana', chats: [] }, 'page:customize': { background: 'aurora', shortcuts: true, recent: true, image: null, appearance: 'system', theme: 'blue' } };
    const { page } = await openInternal(browser, pages.base, 'newtab', { answers });
    await capture(page, 'customize-open', () => page.click('#cz-open'), { n: 5 });
    await capture(page, 'customize-close', () => page.keyboard.press('Escape'), { n: 3 });
    await page.close();
  }
  {
    const answers = {
      'page:settings': { account: { signedIn: false }, profile: { name: '', color: '#86b7ff', theme: 'blue' }, startup: 'newtab', platform: 'darwin', searchEngine: 'google', engines: [], approvalMode: 'ask', appearance: 'system', ai: {}, version: '0.6.7', importSources: [], sitePermissions: [] },
      'page:sync': { on: false, types: {}, requests: [] }, 'page:schedules': { tasks: [] }, 'page:workflows': { workflows: [] }, 'page:site-tips': { sites: [] },
    };
    const { page } = await openInternal(browser, pages.base, 'settings', { answers });
    await capture(page, 'settings-scrollspy', () => page.click('.side a[href="#downloads"]'), { n: 5, rate: 1, every: 120 });
    await page.close();
  }

  // ---------------------------------------------------------------- Reduce Motion: nothing slides or scales
  for (const how of ['system', 'setting']) {
    const reducedMotion = how === 'system' ? 'reduce' : 'no-preference';
    const longest = (page) => page.evaluate(() => Math.max(0, ...document.getAnimations().filter((a) => !a.effect?.target?.classList?.contains('spinner') && a.effect?.getComputedTiming().iterations !== Infinity).map((a) => (a.effect.getComputedTiming().activeDuration || 0) + (a.effect.getComputedTiming().delay || 0))));
    const win = await openPage(browser, base, { reducedMotion, init: { ...INIT, tabs: { activeId: 1, tabs: [tab(1)] }, panel: { open: true, width: 380 } } });
    if (how === 'setting') await emit(win.page, 'ui-prefs', { reduceMotion: true });
    await emit(win.page, 'tabs', { activeId: 2, tabs: [tab(1), tab(2)] });
    await emit(win.page, 'find-open');
    await emit(win.page, 'toast', { text: 'Bookmarked' });
    const w = await longest(win.page);
    await win.page.close();
    const ov = await openPage(browser, base, { reducedMotion, file: 'overlay.html', viewport: { width: 640, height: 440 } });
    if (how === 'setting') await emit(ov.page, 'ui-prefs', { reduceMotion: true });
    await overlay(ov.page, { ...POPOVERS.account.payload, op: 'show', seq: 1, width: 344, height: 420 });
    await overlay(ov.page, { op: 'in', seq: 1 });
    const o = await longest(ov.page);
    await ov.page.close();
    const nt = await openInternal(browser, pages.base, 'newtab', { reducedMotion, answers: { 'page:newtab-data': { topSites: [], bookmarks: [], engine: 'Google', aiReady: true, chats: [] }, 'page:customize': { background: 'none', shortcuts: true, recent: true, theme: 'blue', appearance: 'system' } } });
    if (how === 'setting') await emit(nt.page, 'ui-prefs', { reduceMotion: true });
    await nt.page.click('#cz-open');
    const p = await longest(nt.page);
    const sheet = await nt.page.$eval('#cz-sheet', (el) => getComputedStyle(el).transform);
    await nt.page.close();
    report.reduced[how] = { windowLongestMs: w, overlayLongestMs: o, pagesLongestMs: p, customizeSheetTransform: sheet };
  }
} finally {
  await browser.close();
  server.close();
  pages.server.close();
}

// ---------------------------------------------------------------- CSS: transitions on layout properties
const LAYOUT = /\b(width|height|min-width|max-width|min-height|max-height|top|left|right|bottom|margin[\w-]*|padding[\w-]*|flex-basis|inset)\b/;
for (const dir of ['renderer/ui', 'renderer/pages', 'renderer/assets']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.css'))) {
    const lines = fs.readFileSync(path.join(ROOT, dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/transition(?:-property)?\s*:\s*([^;]+)/);
      if (m && LAYOUT.test(m[1].replace(/var\([^)]*\)/g, ''))) report.layoutTransitions.push(`${dir}/${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
}
fs.writeFileSync(path.join(ROOT, 'dist', 'motion-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, moments: report.moments.length }, null, 2));
