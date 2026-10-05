// Print preview (main/print.js, renderer/ui/print.*): the settings it sends
// to Chromium, and the panel itself in headless Chrome with a stand-in for
// the browser and a real 3-page PDF as its preview, in light and dark.
// The headless part is skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');
const { PrintPreview, cleanSettings, pdfOptions, printOptions, fileName } = require('../main/print.js');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };

// ---------------------------------------------------------------- settings
test('the panel’s settings are checked and filled in', () => {
  assert.deepEqual(cleanSettings({}), {
    destination: 'pdf', ranges: null, copies: 1, layout: 'portrait', color: true, paper: 'Letter',
    perSheet: 1, margins: 'default', scale: 100, headers: false, background: false,
  });
  const s = cleanSettings({ destination: 'Office', ranges: [[1, 3], [5, 5], [0, 2], [4, 2], ['x', 1]], copies: 5000, layout: 'landscape', color: 'bw', paper: 'A4', perSheet: 4, margins: 'none', scale: 500, headers: true, background: 1 });
  assert.deepEqual(s.ranges, [[1, 3], [5, 5]], 'only real 1-based ranges');
  assert.equal(s.copies, 999);
  assert.equal(s.scale, 200);
  assert.equal(s.color, false);
  assert.equal(s.headers, false, 'no headers without margins to put them in');
  assert.equal(s.background, true);
  assert.equal(cleanSettings({ paper: 'B5', perSheet: 3, margins: 'huge', scale: 1 }).paper, 'Letter');
  assert.equal(cleanSettings({ perSheet: 3 }).perSheet, 1);
  assert.equal(cleanSettings({ scale: 1 }).scale, 10);
});

test('Save as PDF and printing get the same choices, each in its own words', () => {
  const s = cleanSettings({ ranges: [[1, 2], [4, 4]], layout: 'landscape', paper: 'A4', margins: 'minimum', scale: 90, headers: true, background: true });
  const pdf = pdfOptions(s);
  assert.equal(pdf.landscape, true);
  assert.equal(pdf.pageSize, 'A4');
  assert.equal(pdf.scale, 0.9);
  assert.equal(pdf.printBackground, true);
  assert.equal(pdf.pageRanges, '1-2,4');
  assert.deepEqual(pdf.margins, { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 });
  assert.equal(pdf.displayHeaderFooter, true);
  assert.match(pdf.headerTemplate, /class="title"/);
  assert.match(pdf.footerTemplate, /class="pageNumber"/);
  assert.equal(pdfOptions(s, { pages: false }).pageRanges, undefined, 'the preview prints every page');
  assert.equal(pdfOptions(cleanSettings({})).margins, undefined, 'Default margins are Chromium’s');
  assert.deepEqual(pdfOptions(cleanSettings({ margins: 'none' })).margins, { top: 0, bottom: 0, left: 0, right: 0 });

  const p = printOptions(cleanSettings({ destination: 'Office', ranges: [[2, 3]], copies: 2, color: 'bw', perSheet: 2, margins: 'minimum', headers: true }), { title: 'Report', url: 'https://example.com/' });
  assert.equal(p.silent, true, 'no second dialog');
  assert.equal(p.deviceName, 'Office');
  assert.equal(p.copies, 2);
  assert.equal(p.color, false);
  assert.equal(p.pagesPerSheet, 2);
  assert.deepEqual(p.margins, { marginType: 'printableArea' });
  assert.deepEqual(p.pageRanges, [{ from: 1, to: 2 }], 'Electron counts pages from 0');
  assert.equal(p.header, 'Report');
  assert.equal(p.footer, 'https://example.com/');
  assert.equal(printOptions(cleanSettings({ destination: 'Office' })).pageRanges, undefined);
});

test('a PDF’s name comes from the page title, safe for any disk', () => {
  assert.equal(fileName('Q3 report: draft/2'), 'Q3 report_ draft_2.pdf');
  assert.equal(fileName(''), 'Page.pdf');
  assert.equal(fileName('a'.repeat(300)).length, 124);
});

// The panel's requests, with stand-ins for the tab, the window and Electron.
function fakePreview({ saveTo = null } = {}) {
  const store = { settings: {}, setSetting(k, v) { this.settings[k] = v; } };
  const toasts = [];
  const calls = [];
  const wc = {
    getTitle: () => 'Report', getURL: () => 'https://example.com/report', isDestroyed: () => false, focus() {}, off() {},
    getPrintersAsync: async () => [{ name: 'office_1', displayName: 'Office', description: '', isDefault: true }, { name: 'home', displayName: '', options: { 'printer-is-default': 'false' } }],
    printToPDF: async (opts) => { calls.push(['pdf', opts]); return Buffer.from('%PDF-1.4 fake'); },
    print: (opts, cb) => { calls.push(['print', opts]); cb(true, ''); },
  };
  const view = { webContents: { isDestroyed: () => false, close() {} } };
  const w = { closed: false, win: { isDestroyed: () => false, off() {}, contentView: { children: [view], removeChildView() {} } } };
  const dialog = { showSaveDialog: async (_win, opts) => { calls.push(['save', opts]); return saveTo ? { canceled: false, filePath: saveTo } : { canceled: true }; } };
  const pp = new PrintPreview({ store, downloadsDir: () => '/tmp', toast: (_w, text) => toasts.push(text), dialog });
  const entry = { view, tab: {}, wc, w };
  pp.open_.set(w, entry);
  return { pp, entry, store, toasts, calls, w };
}

test('the panel’s requests: printers, preview, Save as PDF and Print', async () => {
  const { pp, entry, store, calls } = fakePreview();
  assert.deepEqual(await pp.printers(entry), [
    { name: 'office_1', displayName: 'Office', description: '', isDefault: true },
    { name: 'home', displayName: 'home', description: '', isDefault: false },
  ]);
  const prev = await pp.preview(entry, { layout: 'landscape', ranges: [[1, 1]] });
  assert.equal(prev.ok, true);
  assert.ok(prev.pdf instanceof Uint8Array);
  assert.equal(calls[0][1].landscape, true);
  assert.equal(calls[0][1].pageRanges, undefined, 'the whole printout');

  // Save as PDF, canceled in the save dialog: nothing written, the panel stays.
  assert.deepEqual(await pp.savePdf(entry, {}), { ok: false, canceled: true });
  assert.equal(pp.isOpen(entry.w), true);
  assert.match(calls.find(([k]) => k === 'save')[1].defaultPath, /Report\.pdf$/);

  // Print: silently to the printer, remembering the choices for next time.
  assert.deepEqual(pp.print(entry, { destination: 'pdf' }), { ok: false, error: 'Choose a printer.' });
  assert.deepEqual(pp.print(entry, { destination: 'office_1', copies: 3, color: 'bw' }), { ok: true });
  const printed = calls.find(([k]) => k === 'print')[1];
  assert.equal(printed.deviceName, 'office_1');
  assert.equal(printed.copies, 3);
  assert.equal(pp.isOpen(entry.w), false, 'the panel closes');
  assert.equal(store.settings.printSettings.destination, 'office_1');
  assert.equal(store.settings.printSettings.color, 'bw');
});

test('Save as PDF writes the file where you chose and says so', async () => {
  const out = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lumio-print-')), 'out.pdf');
  const { pp, entry, toasts, store } = fakePreview({ saveTo: out });
  assert.deepEqual(await pp.savePdf(entry, { ranges: [[2, 3]] }), { ok: true, file: out });
  assert.equal(fs.readFileSync(out, 'utf8'), '%PDF-1.4 fake');
  assert.deepEqual(toasts, ['Saved as PDF']);
  assert.equal(store.settings.printSettings.destination, 'pdf');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

// ---------------------------------------------------------------- the panel
let server, browser, base, pdf;
before(async () => {
  if (!CHROME) return;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // A real 3-page printout to preview.
  const maker = await browser.newPage();
  await maker.setContent('<style>section{break-after:page;font:40px sans-serif}</style><section>One</section><section>Two</section><section>Three</section>');
  pdf = await maker.pdf({ format: 'Letter' });
  await maker.close();
  server = http.createServer((req, res) => {
    const url = new URL(`lumio://print${req.url}`);
    if (url.pathname === '/__test.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf); return; }
    let file = resolveFile(url, new Set(['print']));
    // pdf.js is copied into renderer/ui/web when the app is built.
    if (url.pathname.startsWith('/web/') && file && !fs.existsSync(file)) file = path.join(ROOT, 'website', 'public', url.pathname.slice(5));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

const PRINTERS = [{ name: 'office_1', displayName: 'Office printer', description: '', isDefault: true }];

async function openPanel({ colorScheme = 'dark', saved = {}, platform = 'MacIntel' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ saved, printers, platform }) => {
    Object.defineProperty(navigator, 'platform', { get: () => platform });
    window.__sent = [];
    window.__calls = [];
    window.lumio = {
      invoke: async (channel, ...args) => {
        window.__calls.push([channel, ...args]);
        if (channel === 'print:init') return { title: 'Report', url: 'https://example.com/report', platform: 'darwin', settings: { paper: 'Letter', ...saved } };
        if (channel === 'print:printers') return printers;
        if (channel === 'print:preview') return { ok: true, pdf: new Uint8Array(await (await fetch('/__test.pdf')).arrayBuffer()) };
        if (channel === 'print:save-pdf' || channel === 'print:print') return window.__answer || { ok: true };
        return null;
      },
      send: (channel, ...args) => window.__sent.push([channel, ...args]),
      on: () => () => {},
    };
  }, { saved, printers: PRINTERS, platform });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.querySelectorAll('.sheet canvas').length >= 1 && !document.getElementById('go').disabled, null, { timeout: 15_000 });
  const sent = (channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map((s) => s.slice(1)), channel);
  const calls = (channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map((s) => s.slice(1)), channel);
  return { page, errors, sent, calls };
}

for (const scheme of ['light', 'dark']) {
  test(`print preview (${scheme}): pages, Save as PDF, a printer, keys`, { skip }, async () => {
    const { page, errors, sent, calls } = await openPanel({ colorScheme: scheme });
    // Colors follow the computer; the sheets stay white like paper.
    const c = await readColors(page, { tokens: ['--text'], parts: ['.side', '.sheet'] });
    assert.ok(scheme === 'light' ? luminance(c.parts['.side']) > 0.7 : luminance(c.parts['.side']) < 0.05, `the settings are ${scheme}`);
    assert.ok(luminance(c.parts['.sheet']) > 0.95, 'a sheet is white');
    assert.ok(contrast(c.tokens['--text'], c.parts['.side']) >= 4.5, 'readable');

    if (process.env.LUMIO_SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `print-${scheme}.png`) }); }
    assert.equal(await page.title(), 'Print: Report');
    assert.equal(await page.$$eval('.sheet-wrap', (els) => els.length), 3, 'one sheet per page');
    assert.equal(await page.textContent('#count'), '3 pages');
    assert.equal(await page.textContent('#go'), 'Save');
    assert.equal(await page.isVisible('#copies'), false, 'no copies or color for a PDF');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'go', 'ready: Enter saves');

    // Custom pages: a range, then pages that aren't there.
    await page.selectOption('#pages', 'custom');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ranges');
    await page.fill('#ranges', '1-2');
    assert.equal(await page.$$eval('.sheet-wrap', (els) => els.length), 2);
    assert.equal(await page.textContent('#count'), '2 pages');
    await page.fill('#ranges', '2, 7');
    assert.equal(await page.textContent('#ranges-err'), 'There are only 3 pages.');
    assert.equal(await page.getAttribute('#ranges', 'aria-invalid'), 'true');
    assert.equal(await page.isDisabled('#go'), true);
    await page.fill('#ranges', '-2');
    assert.equal(await page.isDisabled('#go'), false);

    // Layout prints the preview again; no margins means no headers.
    const before = (await calls('print:preview')).length;
    await page.selectOption('#layout', 'landscape');
    await page.waitForFunction((n) => window.__calls.filter(([c]) => c === 'print:preview').length > n, before);
    assert.equal((await calls('print:preview')).at(-1)[0].layout, 'landscape');
    await page.click('#more');
    assert.equal(await page.getAttribute('#more', 'aria-expanded'), 'true');
    await page.check('#headers');
    await page.selectOption('#margins', 'none');
    assert.equal(await page.isDisabled('#headers'), true);
    assert.equal(await page.isChecked('#headers'), false);

    // Save as PDF sends the chosen pages.
    await page.waitForFunction(() => !document.getElementById('go').disabled);
    await page.click('#go');
    const saved = (await calls('print:save-pdf')).at(-1)[0];
    assert.equal(saved.destination, 'pdf');
    assert.deepEqual(saved.ranges, [[1, 2]]);
    assert.equal(saved.layout, 'landscape');
    assert.equal(saved.margins, 'none');
    assert.equal(saved.headers, false);

    // A printer: sheets of paper, copies, color; Print sends them.
    await page.selectOption('#dest', 'office_1');
    assert.equal(await page.textContent('#go'), 'Print');
    assert.equal(await page.isVisible('#copies'), true);
    await page.fill('#copies', '2');
    await page.selectOption('#color', 'bw');
    assert.equal(await page.textContent('#count'), '4 sheets of paper');
    await page.selectOption('#per-sheet', '2');
    assert.equal(await page.textContent('#count'), '2 sheets of paper', 'two pages on each sheet, twice');
    assert.equal(await page.$eval('.sheet', (el) => el.classList.contains('bw')), true, 'the preview turns gray');
    await page.click('#go');
    const printed = (await calls('print:print')).at(-1)[0];
    assert.equal(printed.destination, 'office_1');
    assert.equal(printed.copies, 2);
    assert.equal(printed.color, 'bw');
    assert.equal(printed.perSheet, 2);

    // A failure says so, and the button works again.
    await page.evaluate(() => { window.__answer = { ok: false, error: 'busy' }; });
    await page.click('#go');
    await page.waitForFunction(() => /Couldn’t print/.test(document.getElementById('status').textContent));
    assert.equal(await page.isDisabled('#go'), false);

    // The system dialog, and Esc to cancel.
    assert.equal(await page.textContent('#system-keys'), '(⌥⌘P)');
    await page.click('#system');
    assert.equal((await sent('print:system')).length, 1);
    await page.keyboard.press('Escape');
    assert.equal((await sent('print:close')).length, 1);
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('print preview starts from the last choices, with the printer you used', { skip }, async () => {
  const { page, errors } = await openPanel({ saved: { destination: 'office_1', layout: 'landscape', color: 'bw', paper: 'A4', margins: 'minimum', scale: 80, headers: true, background: true } });
  await page.waitForFunction(() => document.getElementById('dest').value === 'office_1');
  assert.equal(await page.inputValue('#layout'), 'landscape');
  assert.equal(await page.inputValue('#color'), 'bw');
  assert.equal(await page.inputValue('#paper'), 'A4');
  assert.equal(await page.inputValue('#margins'), 'minimum');
  assert.equal(await page.inputValue('#scale-mode'), 'custom');
  assert.equal(await page.inputValue('#scale'), '80');
  assert.equal(await page.isChecked('#headers'), true);
  assert.equal(await page.isChecked('#background'), true);
  assert.equal(await page.textContent('#go'), 'Print');
  // A scale out of range says so and can't print.
  await page.click('#more');
  await page.fill('#scale', '300');
  assert.equal(await page.textContent('#scale-err'), 'Choose a scale from 10% to 200%.');
  assert.equal(await page.isDisabled('#go'), true);
  await page.close();
  assert.deepEqual(errors, []);
});
