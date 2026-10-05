// Print preview, Settings › Languages, System and Reset, and Lumio in
// Spanish, in the real app: the preview draws the real page, Save as PDF
// writes a real PDF, websites get the languages you pick, Reset keeps your
// bookmarks, and LUMIO_LANG=es shows menus and pages in Spanish.
// Run: node --test tests/e2e/platform.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

let L;
let site;
let base;
const headers = []; // Accept-Language of each request the site got
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const go = async (url, title) => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), url);
  return until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === title);
};
// Runs code in the print preview's own page.
const inPrint = (code) => L.main(async (_e, c) => {
  const entry = global.lumio.printPreview.stateOf(global.lumio.current);
  return entry ? entry.view.webContents.executeJavaScript(c) : null;
}, code);

before(async () => {
  site = http.createServer((req, res) => {
    headers.push({ url: req.url, lang: req.headers['accept-language'] || '' });
    const pages = Array.from({ length: 3 }, (_, i) => `<section style="height:1100px">Part ${i + 1}</section>`).join('');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Report ${req.url}</title><body>${req.url === '/long' ? pages : '<p>Hello</p>'}</body>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${site.address().port}`;
  L = await launch();
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
});

after(async () => {
  await L?.close();
  site?.close();
});

test('print preview: draws the page, Save as PDF writes it, and it closes with the page', async () => {
  assert.ok(await go(`${base}/long`, 'Report /long'));
  await L.main(() => global.lumio.cmd.print());
  assert.ok(await until(() => L.main(() => global.lumio.printPreview.isOpen(global.lumio.current))), 'opens over the tab');
  // The preview is drawn from the page printed to PDF: a few sheets.
  assert.ok(await until(() => inPrint('document.querySelectorAll("#sheets canvas").length > 0'), 20_000), 'sheets drawn');
  assert.match(await inPrint('document.getElementById("count").textContent'), /\d+ pages?/);

  // Save as PDF: the Save dialog is stood in for, the file is real.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-print-'));
  const file = path.join(dir, 'report.pdf');
  await L.main((_e, f) => {
    const pp = global.lumio.printPreview;
    pp.__dialog = pp.dialog;
    pp.dialog = { showSaveDialog: async () => ({ canceled: false, filePath: f }) };
  }, file);
  try {
    await inPrint('document.getElementById("dest").value = "pdf"; document.getElementById("dest").dispatchEvent(new Event("change", { bubbles: true })); document.getElementById("go").click(); true');
    assert.ok(await until(async () => fs.existsSync(file) && fs.statSync(file).size > 1000, 20_000), 'the PDF is written');
    assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), '%PDF');
    assert.ok(await until(async () => !(await L.main(() => global.lumio.printPreview.isOpen(global.lumio.current)))), 'closes after saving');
  } finally {
    await L.main(() => { const pp = global.lumio.printPreview; pp.dialog = pp.__dialog; delete pp.__dialog; });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Open again, then the page navigates away: the preview goes with it.
  await L.main(() => global.lumio.cmd.print());
  assert.ok(await until(() => L.main(() => global.lumio.printPreview.isOpen(global.lumio.current))));
  assert.ok(await go(`${base}/other`, 'Report /other'));
  assert.ok(await until(async () => !(await L.main(() => global.lumio.printPreview.isOpen(global.lumio.current)))), 'closed by the navigation');

  // Cancel closes it too, and the page gets the keyboard back.
  await L.main(() => global.lumio.cmd.print());
  assert.ok(await until(() => inPrint('!!document.getElementById("cancel")'), 10_000));
  await inPrint('document.getElementById("cancel").click(); true');
  assert.ok(await until(async () => !(await L.main(() => global.lumio.printPreview.isOpen(global.lumio.current)))));
});

test('websites get the languages from Settings › Languages, at once', async () => {
  const before = await L.main(() => global.lumio.store.settings.languages);
  try {
    await L.main(() => global.lumio.store.setSetting('languages', ['fr-CA', 'de']));
    headers.length = 0;
    assert.ok(await go(`${base}/lang`, 'Report /lang'));
    const got = headers.find((h) => h.url === '/lang');
    assert.match(got.lang, /^fr-CA,fr;q=[\d.]+,de;q=[\d.]+$/);
  } finally {
    await L.main((_e, v) => global.lumio.store.setSetting('languages', v), before ?? undefined);
  }
});

test('Settings › System and Reset settings: acceleration waits for a restart; Reset keeps bookmarks', async () => {
  const state = await L.main(() => {
    const sys = global.lumio.system;
    const changed = sys.set('hardwareAcceleration', false);
    const back = sys.set('hardwareAcceleration', true);
    return { changed, back };
  });
  assert.equal(state.changed.restart, true);
  assert.equal(state.back.restart, false);

  // Reset from Settings itself (its own handler), with a bookmark and a changed engine.
  assert.ok(await go('lumio://settings/', 'Settings'));
  const saved = await L.main((_e, u) => {
    const { store } = global.lumio.current.profile;
    const engine = store.settings.searchEngine;
    store.setSetting('searchEngine', 'bing');
    store.addBookmarkAt(u, 'Kept', 0);
    return engine;
  }, `${base}/kept`);
  try {
    assert.equal(await L.page('window.lumioPage.invoke("page:reset-settings")'), true);
    const after = await L.main((_e, u) => {
      const { store } = global.lumio.current.profile;
      return { engine: store.settings.searchEngine, kept: store.bookmarks().some((b) => b.url === u) };
    }, `${base}/kept`);
    assert.equal(after.engine, 'google');
    assert.equal(after.kept, true, 'bookmarks stay');
  } finally {
    await L.main((_e, { u, engine }) => {
      const { store } = global.lumio.current.profile;
      store.removeBookmark(u);
      store.setSetting('searchEngine', engine);
    }, { u: `${base}/kept`, engine: saved });
    await L.main(() => global.lumio.tabs.navigate('about:blank'));
  }
});

test('Settings in the real app has the search box, Languages, System and Reset', async () => {
  assert.ok(await go('lumio://settings/', 'Settings'));
  assert.ok(await until(() => L.page('document.querySelectorAll("#lang-list li").length > 0'), 10_000), 'Languages loaded');
  const info = await L.page(`({
    search: !!document.getElementById('settings-search'),
    sections: ['languages', 'system', 'reset'].every((id) => document.getElementById(id)),
    gpu: document.getElementById('sys-gpu').checked,
  })`);
  assert.deepEqual(info, { search: true, sections: true, gpu: true });
  await L.page('(() => { const i = document.getElementById("settings-search"); i.value = "proxy"; i.dispatchEvent(new Event("input")); return true; })()');
  assert.ok(await until(() => L.page('getComputedStyle(document.getElementById("languages")).display === "none" && getComputedStyle(document.getElementById("system")).display !== "none"')));
  await L.main(() => global.lumio.tabs.navigate('about:blank'));
});

test('Lumio in Spanish: menus and pages', async () => {
  const es = await launch({ env: { LUMIO_LANG: 'es' } });
  try {
    await until(() => es.main(() => !!global.lumio.tabs?.active), 15_000);
    const labels = await es.main(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) || []);
    assert.ok(labels.includes('Archivo') || labels.includes('Editar'), `menus in Spanish: ${labels.join(', ')}`);
    await es.main(() => global.lumio.tabs.navigate('lumio://settings/'));
    assert.ok(await until(async () => (await es.page('document.documentElement.lang')) === 'es', 10_000));
    assert.ok(await until(async () => /Idiomas/.test(await es.page('document.getElementById("languages")?.textContent || ""')), 10_000), 'Languages section in Spanish');
    assert.ok(await until(async () => (await es.page('document.getElementById("settings-search").placeholder')) !== 'Search settings'));
  } finally {
    await es.close();
  }
});
