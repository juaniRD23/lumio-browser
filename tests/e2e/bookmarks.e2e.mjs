// End-to-end tests for bookmarks in the real app: the flat list from before
// folders becomes the Bookmarks bar; the star's bubble (name, folder,
// Choose another folder…, Remove); Bookmark All Tabs into a folder and that
// folder's menu on the bar; the bookmark manager's tree, delete with Undo and
// sort by name; exporting with folders; and the new tab page's shortcuts.
// Run: node --test tests/e2e/bookmarks.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// A profile from a version before folders: bookmarks.json is a flat list.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-bookmarks-e2e-'));
let L;
let site;
let base;

const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await L.wait(150);
  }
};
const title = () => L.main(() => global.lumio.tabs.wc().getTitle());
const go = async (url, expectTitle) => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), url);
  assert.ok(await until(async () => (await title()).includes(expectTitle)), `page "${expectTitle}" loaded`);
};
// The overlay above the page draws the folder menus and the star's bubble.
const kind = () => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current));
const overlay = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
const idOf = (url) => L.main((_e, u) => global.lumio.store.marks.byUrl(u)[0]?.id || null, url);
const parentTitle = (id) => L.main((_e, i) => global.lumio.store.marks.parentOf(i)?.title || null, id);

before(async () => {
  site = http.createServer((q, r) => {
    const name = new URL(q.url, 'http://x').pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1>`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  fs.writeFileSync(path.join(profile, 'bookmarks.json'), JSON.stringify([
    { url: `${base}/old-1`, title: 'Old one', time: 1000 },
    { url: `${base}/old-2`, title: 'Old two', time: 2000, favicon: ICON },
  ]));
  L = await launch({ profile });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  await L?.close();
  site?.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

test('bookmarks from before folders become the Bookmarks bar, in order, with their icons', async () => {
  const bar = await L.main(() => global.lumio.store.marks.root('bar').children.map(({ title: t, url, favicon }) => ({ title: t, url, favicon: favicon || null })));
  assert.deepEqual(bar, [{ title: 'Old one', url: `${base}/old-1`, favicon: null }, { title: 'Old two', url: `${base}/old-2`, favicon: ICON }]);
  assert.deepEqual(await L.main(() => global.lumio.store.marks.roots.map((r) => r.title)), ['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks']);
  assert.ok(fs.existsSync(path.join(profile, 'bookmark-tree.json')), 'saved as a tree');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'bookmarks.json'), 'utf8')).length, 2, 'the old file is left as it was');
  assert.ok(await until(() => L.shell(`[...document.querySelectorAll('#bookmarks-bar .bm-items .bm-item span')].map((s) => s.textContent).join('|') === 'Old one|Old two'`)));
  assert.equal(await L.shell(`!!document.getElementById('bm-all')`), true, 'All bookmarks at the right end');
});

test('the star bookmarks the page and opens its bubble: name, folder, Choose another folder…, Remove', async () => {
  await go(`${base}/star`, 'Page star');
  await L.main(() => global.lumio.cmd.bookmark());
  assert.ok(await until(async () => (await kind()) === 'bm-edit'), 'the bubble opened');
  const id = await idOf(`${base}/star`);
  assert.ok(id, 'bookmarked right away');
  assert.equal(await parentTitle(id), 'Bookmarks bar');
  assert.ok(await until(() => overlay(`document.querySelector('.bmb-head')?.textContent === 'Bookmark added' && document.getElementById('bmb-name').value === 'Page star'`)));

  // A new name applies as it's typed; picking Other bookmarks moves it there.
  await overlay(`(() => {
    const n = document.getElementById('bmb-name');
    n.value = 'Starred';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    const f = document.getElementById('bmb-folder');
    f.value = 'other';
    f.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.ok(await until(async () => (await L.main((_e, i) => global.lumio.store.marks.get(i)?.title, id)) === 'Starred' && (await parentTitle(id)) === 'Other bookmarks'));
  // Other bookmarks now has something, so it shows at the bar's right end.
  assert.ok(await until(() => L.shell(`!!document.querySelector('#bookmarks-bar .bm-end .bm-folder[data-id="other"]')`)));

  // Choose another folder…: every folder as a tree; New folder makes one there and moves it in.
  await overlay(`(() => { const f = document.getElementById('bmb-folder'); f.value = '__choose'; f.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
  assert.ok(await until(() => overlay(`!document.querySelector('.bmb-pick').hidden && [...document.querySelectorAll('.bmb-tree .bmb-folder')].map((r) => r.textContent).join('|') === 'Bookmarks bar|Other bookmarks|Mobile bookmarks'`)));
  await overlay(`(() => {
    document.querySelector('.bmb-tree .bmb-folder[data-id="bar"]').click();
    document.querySelector('[data-act=new]').click();
    document.getElementById('bmb-new').value = 'Reading';
    document.querySelector('[data-act=save]').click();
    return true;
  })()`);
  assert.ok(await until(async () => (await parentTitle(id)) === 'Reading'));
  const reading = await L.main((_e, i) => global.lumio.store.marks.parentOf(i).id, id);
  assert.equal(await L.main((_e, f) => global.lumio.store.marks.parentOf(f).id, reading), 'bar');
  assert.ok(await until(() => overlay(`document.getElementById('bmb-folder').selectedOptions[0]?.textContent === 'Reading'`)), 'the bubble shows the new folder');

  // Remove takes it away and closes the bubble.
  await overlay(`document.querySelector('[data-act=remove]').click(); true`);
  assert.ok(await until(async () => (await kind()) === null));
  assert.equal(await idOf(`${base}/star`), null);

  // Bookmarked again, it goes in the folder used last; on a bookmarked page the star edits it.
  await L.main(() => global.lumio.cmd.bookmark());
  assert.ok(await until(async () => (await kind()) === 'bm-edit'));
  const again = await idOf(`${base}/star`);
  assert.equal(await parentTitle(again), 'Reading');
  await overlay(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  assert.ok(await until(async () => (await kind()) === null), 'Esc closes it');
  await L.main(() => global.lumio.cmd.bookmark());
  assert.ok(await until(() => overlay(`document.querySelector('.bmb-head')?.textContent === 'Edit bookmark'`)));
  assert.equal(await L.main((_e, u) => global.lumio.store.marks.byUrl(u).length, `${base}/star`), 1, 'not bookmarked twice');
  await overlay(`document.querySelector('[data-act=done]').click(); true`);
  assert.ok(await until(async () => (await kind()) === null));
});

test('Bookmark All Tabs puts the window’s pages in a new folder; its menu on the bar opens them', async () => {
  await go(`${base}/one`, 'Page one');
  await L.main((_e, u) => global.lumio.tabs.create(u, { active: false }), `${base}/two`);
  assert.ok(await until(() => L.main(() => global.lumio.tabs.tabs.some((t) => t.title === 'Page two'))));
  await L.main(() => global.lumio.cmd.bookmarkAllTabs());
  assert.ok(await until(() => overlay(`document.querySelector('.bmb-head')?.textContent === 'Bookmarked 2 tabs'`)));
  const folder = await L.main(() => global.lumio.store.marks.folders().find((f) => f.title === 'Saved tabs')?.id);
  assert.ok(folder, 'a new folder');
  assert.deepEqual(await L.main((_e, f) => global.lumio.store.marks.folder(f).children.map((n) => n.url).sort(), folder), [`${base}/one`, `${base}/two`]);
  // Named and put on the bar from the bubble.
  await overlay(`(() => {
    const n = document.getElementById('bmb-name');
    n.value = 'Trip';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    const f = document.getElementById('bmb-folder');
    f.value = 'bar';
    f.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-act=done]').click();
    return true;
  })()`);
  assert.ok(await until(async () => (await kind()) === null));
  assert.ok(await until(async () => (await L.main((_e, f) => global.lumio.store.marks.get(f)?.title, folder)) === 'Trip' && (await parentTitle(folder)) === 'Bookmarks bar'));

  // On the bar, the folder opens a menu with its pages; picking one opens it.
  assert.ok(await until(() => L.shell(`!!document.querySelector('#bookmarks-bar .bm-folder[data-id="${folder}"]:not([hidden])')`)));
  await L.shell(`document.querySelector('#bookmarks-bar .bm-folder[data-id="${folder}"]').click(); true`);
  assert.ok(await until(async () => (await kind()) === 'bm-menu'), 'the folder menu opened');
  assert.equal(await L.shell(`document.querySelector('#bookmarks-bar .bm-folder[data-id="${folder}"]').getAttribute('aria-expanded')`), 'true');
  assert.ok(await until(() => overlay(`document.querySelectorAll('.bm-menu .bm-row').length === 2`)));
  assert.equal(await title(), 'Page one');
  await overlay(`[...document.querySelectorAll('.bm-menu .bm-row')].find((r) => r.textContent.includes('Page two')).click(); true`);
  assert.ok(await until(async () => (await title()).includes('Page two')), 'the bookmark opened in this tab');
  assert.ok(await until(async () => (await kind()) === null), 'and the menu closed');
});

test('bookmark manager: the folder tree, a folder’s contents, delete with Undo, sort by name with Undo', async () => {
  await go('lumio://bookmarks/', 'Bookmarks');
  assert.ok(await until(() => L.page(`[...document.querySelectorAll('#tree .tf .tt')].map((t) => t.textContent).join('|').startsWith('Bookmarks bar')`)));
  const tree = await L.page(`[...document.querySelectorAll('#tree .tf .tt')].map((t) => t.textContent)`);
  assert.ok(tree.includes('Other bookmarks') && tree.includes('Reading') && tree.includes('Trip'), tree.join(', '));
  const rows = () => L.page(`[...document.querySelectorAll('#list .bm-row[data-id] .t')].map((t) => t.textContent)`);
  assert.deepEqual(await rows(), ['Old one', 'Old two', 'Reading', 'Trip']);

  // A folder in the tree shows what's in it.
  const trip = await L.main(() => global.lumio.store.marks.folders().find((f) => f.title === 'Trip').id);
  await L.page(`document.querySelector('#tree .tf[data-id="${trip}"]').click(); true`);
  assert.ok(await until(async () => (await rows()).length === 2 && (await L.page(`document.querySelector('#crumbs .crumb.now').textContent`)) === 'Trip'));

  // Delete (the key) and Undo.
  const one = await idOf(`${base}/one`);
  await L.page(`(() => { const r = document.querySelector('#list .bm-row[data-id="${one}"]'); r.click(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); return true })()`);
  assert.ok(await until(async () => (await idOf(`${base}/one`)) === null), 'deleted');
  assert.ok(await until(() => L.page(`!document.getElementById('toast').hidden && !document.getElementById('toast-undo').hidden`)));
  await L.page(`document.getElementById('toast-undo').click(); true`);
  assert.ok(await until(async () => (await parentTitle(await idOf(`${base}/one`))) === 'Trip'), 'back where it was');
  assert.ok(await until(async () => (await rows()).length === 2));

  // Sort the bar by name (folders first) from the ⋮ menu, then Undo.
  await L.page(`document.querySelector('#tree .tf[data-id="bar"]').click(); true`);
  assert.ok(await until(async () => (await rows()).length === 4));
  await L.page(`(() => { document.getElementById('more').click(); document.querySelector('#menu [data-cmd=sort]').click(); return true })()`);
  const barTitles = () => L.main(() => global.lumio.store.marks.root('bar').children.map((n) => n.title));
  assert.ok(await until(async () => (await barTitles()).join('|') === 'Reading|Trip|Old one|Old two'));
  await L.page(`document.getElementById('toast-undo').click(); true`);
  assert.ok(await until(async () => (await barTitles()).join('|') === 'Old one|Old two|Reading|Trip'));
});

test('export writes the folders, the bar marked as the toolbar', async () => {
  const html = await L.main(() => global.lumio.store.marks.toHtml());
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar<\/H3>/);
  assert.match(html, /<H3 ADD_DATE="\d+">Trip<\/H3>\s*<DL><p>\s*<DT><A HREF="http:\/\/127\.0\.0\.1:\d+\/(one|two)"/);
});

test('new tab shortcuts: add one, remove it with Undo, switch to Most visited, hide them', async () => {
  await L.main(() => global.lumio.cmd.newTab());
  assert.ok(await until(async () => (await title()) === 'New Tab'));
  assert.ok(await until(() => L.page(`!!document.getElementById('sc-add')`)));

  // Add shortcut.
  await L.page(`document.getElementById('sc-add').click(); true`);
  await L.page(`(() => {
    const u = document.getElementById('sc-url');
    u.value = 'shortcut.example';
    u.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sc-name').value = 'My site';
    document.getElementById('sc-done').click();
    return true;
  })()`);
  const saved = () => L.main(() => (global.lumio.store.settings.ntpShortcuts?.custom || []).some((s) => s.url === 'https://shortcut.example/' && s.title === 'My site'));
  assert.ok(await until(saved));
  assert.ok(await until(() => L.page(`[...document.querySelectorAll('#sites .site .name')].some((n) => n.textContent === 'My site')`)));

  // Remove it from its ⋮ menu; the toast's Undo brings it back.
  const i = await L.page(`[...document.querySelectorAll('#sites .tile')].findIndex((t) => t.querySelector('.name')?.textContent === 'My site')`);
  await L.page(`(() => { document.querySelector('#sites [data-menu="${i}"]').click(); document.querySelector('.sc-menu [data-item=remove]').click(); return true })()`);
  assert.ok(await until(() => L.page(`!document.querySelector('.sc-toast').hidden && document.querySelector('.sc-toast-text').textContent === 'Shortcut removed'`)));
  assert.equal(await saved(), false);
  await L.page(`document.querySelector('.sc-toast [data-toast=undo]').click(); true`);
  assert.ok(await until(saved), 'Undo put it back');

  // Customize: Most visited sites (no Add shortcut there), then hide them.
  await L.page(`document.querySelector('.sc-customize').click(); true`);
  await L.page(`(() => { const r = document.querySelector('[name=sc-mode][value=mostVisited]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
  assert.ok(await until(() => L.main(() => global.lumio.store.settings.ntpShortcuts.mode === 'mostVisited')));
  assert.ok(await until(() => L.page(`!document.getElementById('sc-add') && ![...document.querySelectorAll('#sites .name')].some((n) => n.textContent === 'My site')`)));
  await L.page(`(() => { const c = document.getElementById('sc-show'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
  assert.ok(await until(() => L.page(`document.getElementById('sites').hidden`)));
  assert.equal(await L.main(() => global.lumio.store.settings.ntpShortcuts.hidden), true);
  await L.page(`document.querySelector('dialog[open] [type=submit]').click(); true`);
});
