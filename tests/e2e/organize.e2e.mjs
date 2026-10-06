// End-to-end tests for tab groups, saved groups, the reading list and the
// side panel in the real app: a group made from the tab menu's command, its
// chip, collapsing it, the session file and a restart that brings it back;
// moving a group to a new window; saving a group, closing it and reopening
// it from the bookmarks bar; adding pages to the reading list and reading
// them from the side panel; and the side panel's switcher sharing the
// column with Lumio AI.
// Run: node --test tests/e2e/organize.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-organize-e2e-'));
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
const windows = () => L.main(() => global.lumio.windows.map((w) => w.tabs.tabs.length));
const open = async (name) => {
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/${name}`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes(name)), `page ${name} loaded`);
  return L.main(() => global.lumio.tabs.activeId);
};
const groupOf = (id) => L.main((_e, i) => global.lumio.tabs.get(i)?.groupId || null, id);
// Leaves the window with one new tab and no groups, so tests don't depend on each other.
const reset = async () => {
  await L.main(() => {
    const t = global.lumio.tabs;
    t.create('lumio://newtab/');
    for (const tab of [...t.tabs]) if (tab.id !== t.activeId) t.close(tab.id);
  });
  await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === 1);
};

async function start() {
  L = await launch({ profile });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
}

before(async () => {
  site = http.createServer((q, r) => {
    const name = new URL(q.url, 'http://x').pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1>`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  await start();
});

after(async () => {
  await L?.close();
  site?.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

test('tab groups: a chip in the strip, collapse, the editor, and the session keeps them through a restart', async () => {
  const a = await open('alpha');
  const b = await open('beta');
  await open('gamma');
  const groupId = await L.main((_e, ids) => {
    const w = global.lumio.current;
    return global.lumio.groups.newGroup(w, ids).id;
  }, [a, b]);
  assert.equal(await groupOf(a), groupId);
  assert.equal(await groupOf(b), groupId);
  // The editor opens for a new group; naming it shows on the chip.
  assert.ok(await until(async () => (await L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current))) === 'tab-group'), 'the editor opened');
  await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`(() => { const i = document.getElementById('tg-name'); i.value = 'Research'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.tg-color[data-color="green"]').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`));
  assert.ok(await until(() => L.shell(`document.querySelector('.tab-group-chip')?.textContent === 'Research'`)), 'the chip shows the name');
  assert.equal(await L.main((_e, g) => global.lumio.tabs.groups.get(g).color, groupId), 'green');
  // Click the chip: collapsed; the tabs fold away and the active tab (gamma) stays.
  await L.shell(`document.querySelector('.tab-group-chip').click(), true`);
  assert.ok(await until(() => L.main((_e, g) => global.lumio.tabs.groups.get(g).collapsed, groupId)));
  assert.ok(await until(() => L.shell(`document.querySelectorAll('.tab.collapsed-away').length === 2`)));
  // The session file has the group; after a restart it's back.
  await L.wait(700);
  const saved = await L.main(() => global.lumio.store.sessionWindows()[0]);
  assert.deepEqual(saved.groups.map((g) => [g.title, g.color, g.collapsed]), [['Research', 'green', true]]);
  assert.equal(saved.tabs.filter((t) => t.group === groupId).length, 2);
  await L.close();
  await start();
  const back = await L.main(() => ({ groups: global.lumio.tabs.groups.state().map((g) => [g.title, g.color, g.count]), urls: global.lumio.tabs.tabs.filter((t) => t.groupId).map((t) => t.url) }));
  assert.deepEqual(back.groups, [['Research', 'green', 2]]);
  assert.ok(back.urls[0].endsWith('/alpha') && back.urls[1].endsWith('/beta'));
  assert.ok(await until(() => L.shell(`document.querySelector('.tab-group-chip')?.textContent === 'Research'`)));
  await reset();
});

test('a tab opened from a grouped tab joins the group; ungroup keeps the tabs', async () => {
  try {
    const a = await open('one');
    const g = await L.main((_e, id) => global.lumio.tabs.groups.create([id]).id, a);
    // A real click on a link to a new tab (the pop-up blocker lets only the person's clicks open one).
    const at = await L.page(`(() => { const l = document.createElement('a'); l.href = '/two'; l.target = '_blank'; l.textContent = 'Two'; l.style = 'position:fixed;left:20px;top:20px;font-size:30px'; document.body.append(l); const r = l.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    await L.main((_e, p) => {
      const wc = global.lumio.tabs.wc();
      wc.focus();
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      return true;
    }, at);
    assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === 3));
    assert.equal(await L.main(() => global.lumio.tabs.tabs.filter((t) => t.groupId).length), 2);
    await L.main((_e, id) => global.lumio.tabs.groups.ungroup(id), g);
    await L.wait(100);
    assert.equal(await L.main(() => global.lumio.tabs.tabs.filter((t) => t.groupId).length), 0);
    assert.equal(await L.main(() => global.lumio.tabs.tabs.length), 3);
    assert.equal(await L.shell(`document.querySelectorAll('.tab-group-chip').length`), 0);
  } finally {
    await reset();
  }
});

test('move group to new window takes its pages along, still grouped', async () => {
  const a = await open('mv-a');
  const b = await open('mv-b');
  await open('stay');
  await L.page('window.__marker = 7; true');
  await L.main((_e, ids) => { const w = global.lumio.current; const g = w.tabs.groups.create(ids, { title: 'Movers' }); global.lumio.groups.action(w, g.id, 'move-window'); }, [a, b]);
  assert.ok(await until(async () => (await windows()).length === 2));
  const moved = await L.main(() => { const w = global.lumio.windows.at(-1); return { titles: w.tabs.groups.state().map((g) => g.title), count: w.tabs.tabs.length }; });
  assert.deepEqual(moved, { titles: ['Movers'], count: 2 });
  await L.main(() => global.lumio.windows.at(-1).close());
  assert.ok(await until(async () => (await windows()).length === 1));
  await reset();
});

test('saved groups: save, close, then reopen from the bookmarks bar', async () => {
  const a = await open('saved-a');
  const b = await open('saved-b');
  const gid = await L.main((_e, ids) => {
    const w = global.lumio.current;
    const g = w.tabs.groups.create(ids, { title: 'Weekend', color: 'pink' });
    global.lumio.groups.action(w, g.id, 'save');
    return g.id;
  }, [a, b]);
  const savedId = await L.main((_e, g) => global.lumio.tabs.groups.get(g).savedId, gid);
  assert.ok(savedId);
  assert.ok(await until(() => L.shell(`document.querySelector('.bm-sg span')?.textContent === 'Weekend'`)), 'on the bookmarks bar');
  // The copy follows the open group.
  await L.main((_e, g) => global.lumio.tabs.groups.update(g, { title: 'Long weekend' }), gid);
  assert.ok(await until(() => L.main((_e, s) => global.lumio.groups.saved.get(s).title === 'Long weekend', savedId)));
  // Close the group: it stays saved; clicking it on the bar opens it again.
  await L.main((_e, g) => global.lumio.groups.action(global.lumio.current, g, 'close'), gid);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.filter((t) => t.groupId).length)) === 0));
  await L.shell(`document.querySelector('.bm-sg').click(), true`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.filter((t) => t.groupId).length)) === 2));
  assert.deepEqual(await L.main(() => global.lumio.tabs.groups.state().map((g) => [g.title, g.color, !!g.savedId])), [['Long weekend', 'pink', true]]);
  // Clicking it again goes to it instead of opening a copy.
  await L.shell(`document.querySelector('.bm-sg').click(), true`);
  await L.wait(300);
  assert.equal(await L.main(() => global.lumio.tabs.groups.state().length), 1);
  assert.ok(fs.existsSync(path.join(profile, 'saved-groups.json')));
  await L.main((_e, s) => global.lumio.groups.saved.remove(s), savedId);
  await reset();
});

test('reading list: add the page, see it in the side panel, open it to mark it read', async () => {
  await open('later');
  await L.main(() => global.lumio.cmd.addToReadingList());
  const item = await L.main(() => global.lumio.sidePanel.reading.list()[0]);
  assert.ok(item.url.endsWith('/later') && item.read === false);
  // The side panel on the reading list.
  await L.main(() => global.lumio.cmd.sidePanel('reading'));
  assert.ok(await until(() => L.shell(`document.querySelector('.ss-tab[data-view="reading"]')?.getAttribute('aria-selected') === 'true'`)));
  assert.ok(await until(() => L.shell(`!!document.querySelector('#side-view .sv-row[data-rid]')`)), 'the page shows');
  assert.equal(await L.shell(`getComputedStyle(document.getElementById('messages')).display`), 'none', 'the chat steps aside');
  // Open it from the list: it's read now.
  await L.shell(`document.querySelector('#side-view .sv-row[data-rid] .sv-t').click(), true`);
  assert.ok(await until(() => L.main(() => global.lumio.sidePanel.reading.list()[0].read)));
  assert.ok(await until(() => L.shell(`!!document.querySelector('#side-view .sv-row[data-read]')`)));
  // The view is remembered.
  assert.equal(await L.main(() => global.lumio.store.settings.sidePanelView), 'reading');
  // Lumio AI's button brings the chat back.
  await L.shell(`document.getElementById('ai-toggle').click(), true`);
  assert.ok(await until(() => L.shell(`document.querySelector('.ss-tab[data-view="ai"]').getAttribute('aria-selected') === 'true'`)));
  await L.main((_e, id) => global.lumio.sidePanel.reading.remove(id), item.id);
  await reset();
});

test('incognito: no reading list or saved groups', async () => {
  await L.main(() => global.lumio.createWindow({ incognito: true, urls: ['about:blank'] }));
  assert.ok(await until(async () => (await windows()).length === 2));
  const w = await L.main(() => { const w = global.lumio.windows.at(-1); return { added: global.lumio.sidePanel.add(w, 'https://example.com/', 'x'), items: global.lumio.sidePanel.reading.list().length }; });
  assert.deepEqual(w, { added: false, items: 0 });
  await L.main(() => global.lumio.windows.at(-1).close());
  assert.ok(await until(async () => (await windows()).length === 1));
});
