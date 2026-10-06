// End-to-end tests for where tabs go: tabs to the side (main/tab-layout.js,
// renderer/ui/vertical-tabs.js) and split view (main/split-view.js,
// renderer/ui/split-view.js), in the real app. The UI calls go through the
// window's own bridge (window.lumio.send), the same way clicks do.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

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
const send = (channel, payload) => L.shell(`window.lumio.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)}); true`);
const open = async (name) => {
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/${name}`);
  assert.ok(await until(() => L.main((_e, n) => global.lumio.tabs.wc()?.getTitle() === `Page ${n}`, name)), `page ${name} loaded`);
};

before(async () => {
  site = http.createServer((q, r) => {
    const name = new URL(q.url, 'http://x').pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1><p>Some text about ${name}. <a id="link" href="/linked">A link</a></p>`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  L = await launch();
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  await L?.close();
  site?.close();
});

test('tabs to the side: the column replaces the strip, the page moves over, and the window remembers it', async () => {
  await open('one');
  await open('two');
  const before = await L.main(() => global.lumio.tabs.active.view.getBounds());
  await send('layout:tabs', { vertical: true });
  assert.ok(await until(() => L.shell(`document.body.classList.contains('vtabs') && document.querySelectorAll('#vtabs .vt-tab').length >= 2`)), 'the column shows the tabs');
  assert.equal(await L.shell(`getComputedStyle(document.getElementById('tabstrip')).display`), 'none');
  assert.deepEqual(await L.main(() => global.lumio.current.tabLayout), { vertical: true, collapsed: false });
  // The page sits right of the column, and starts higher (no strip above the toolbar).
  const col = JSON.parse(await L.shell(`JSON.stringify(document.getElementById('vtabs').getBoundingClientRect())`));
  const after = await until(async () => {
    const b = await L.main(() => global.lumio.tabs.active.view.getBounds());
    return b.x >= col.right && b.y < before.y ? b : null;
  });
  assert.ok(after, 'the page moved over and up');
  await shot('layout-01-vertical');
  // The active tab is the selected row; Enter on another row switches to it.
  assert.equal(await L.shell(`document.querySelector('#vtabs .vt-tab.active .title').textContent`), 'Page two');
  await L.shell(`(() => { const row = [...document.querySelectorAll('#vtabs .vt-tab')].find((r) => r.textContent.includes('Page one')); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`);
  assert.ok(await until(() => L.main(() => global.lumio.tabs.wc().getTitle() === 'Page one')));
  // New windows follow the last choice; the session keeps each window's own.
  assert.equal(await L.main(() => global.lumio.store.settings.verticalTabs), true);
  await send('layout:tabs', { collapsed: true });
  assert.ok(await until(() => L.shell(`document.getElementById('vtabs').getBoundingClientRect().width < 50`)), 'collapsed to icons');
  await L.wait(600);
  assert.deepEqual(await L.main(() => global.lumio.store.sessionWindows()[0].layout), { vertical: true, collapsed: true });
  await L.main(() => global.lumio.cmd.newWindow());
  await until(() => L.main(() => global.lumio.windows.length === 2));
  assert.deepEqual(await L.main(() => global.lumio.current.tabLayout), { vertical: true, collapsed: false });
  await L.main(() => global.lumio.cmd.closeWindow());
  await until(() => L.main(() => global.lumio.windows.length === 1));
  await L.main(() => global.lumio.focus(global.lumio.windows[0]));
});

test('tabs to the side: the collapsed column’s flyout closes when the pointer isn’t over it', async () => {
  // Main asks the OS where the pointer is, so put the flyout where it isn't.
  const rect = await L.main(({ screen }) => {
    const w = global.lumio.current;
    const c = w.win.getContentBounds();
    const p = screen.getCursorScreenPoint();
    const x = p.x - c.x > 300 ? 8 : Math.min(c.width - 300, Math.max(8, p.x - c.x + 80));
    return { x, y: 100, width: 276, height: 300 };
  });
  await L.main(() => global.lumio.current.hideOverlay()); // no other dropdown open (the flyout never covers one)
  await send('overlay:show', { rect, payload: { kind: 'vtabs', tabs: [], activeId: null } });
  // The flyout was shown (the overlay page drew it), then closed by itself.
  assert.ok(await until(() => L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`document.body.classList.contains('vtabs-flyout')`)), 3000), 'the overlay drew the flyout');
  assert.ok(await until(() => L.main(() => global.lumio.current.overlayKind === null), 3000), 'closed by itself');
  // Back to the strip across the top.
  await send('layout:tabs', { vertical: false });
  assert.ok(await until(() => L.shell(`!document.body.classList.contains('vtabs') && getComputedStyle(document.getElementById('tabstrip')).display !== 'none'`)));
  assert.equal(await L.main(() => global.lumio.store.settings.verticalTabs), false);
  assert.equal(await L.shell(`document.getElementById('sb-open').nextElementSibling.id`), 'tabs', 'the strip’s buttons are back in place');
});

test('split view: two pages side by side; the focused side drives the toolbar, find and the page tools', async () => {
  await open('left');
  await open('right');
  const [a, b] = await L.main(() => global.lumio.tabs.tabs.slice(-2).map((t) => t.id));
  await L.main((_e, [x, y]) => { const t = global.lumio.tabs; t.split.create(x, y); t.activate(x); }, [a, b]);
  // The window draws the panes and tells main where each page goes.
  assert.ok(await until(() => L.main(() => !!global.lumio.tabs.split.rects)), 'the shell measured its panes');
  const geo = await L.main((_e, [x, y]) => {
    const t = global.lumio.tabs;
    return { left: t.get(x).view.getBounds(), right: t.get(y).view.getBounds(), slot: t.slot };
  }, [a, b]);
  assert.ok(geo.left.x + geo.left.width < geo.right.x, `side by side: ${JSON.stringify(geo)}`);
  assert.equal(geo.left.y, geo.right.y);
  assert.ok(geo.left.y > geo.slot.y, 'under the panes’ bars');
  assert.ok(geo.left.x >= geo.slot.x && geo.right.x + geo.right.width <= geo.slot.x + geo.slot.width + 1);
  assert.equal(await L.shell(`document.querySelectorAll('#tabs .tab:not([hidden]) .split-ic:not([hidden])').length`), 2, 'both tabs carry the split icon');
  assert.match(await L.shell(`document.getElementById('address').value`), /\/left$/);
  await shot('layout-02-split');

  // Clicking into the right page makes it the focused side.
  await L.main((_e, y) => global.lumio.tabs.get(y).view.webContents.focus(), b);
  assert.ok(await until(() => L.main((_e, y) => global.lumio.tabs.activeId === y, b)), 'the right side is focused');
  assert.ok(await until(async () => /\/right$/.test(await L.shell(`document.getElementById('address').value`))), 'the toolbar shows it');
  assert.equal(await L.page('document.title'), 'Page right', 'page tools and Lumio work on the focused side');
  assert.equal(await L.shell(`document.querySelector('.pane.focused').dataset.side`), 'right');
  // Find in page searches the focused side.
  await L.main(() => global.lumio.cmd.find());
  await L.shell(`(() => { const i = document.getElementById('find-input'); i.value = 'right'; i.dispatchEvent(new Event('input')); return true })()`);
  assert.ok(await until(async () => /\d+\/\d+/.test(await L.shell(`document.getElementById('find-count').textContent`))), 'matches counted on the focused side');
  await L.shell(`document.getElementById('find-close').click(); true`);

  // The divider: main keeps the new width; the left page narrows.
  await send('tab:split-ratio', { id: a, ratio: 0.35 });
  assert.ok(await until(async () => {
    const [l, r] = await L.main((_e, [x, y]) => [global.lumio.tabs.get(x).view.getBounds(), global.lumio.tabs.get(y).view.getBounds()], [a, b]);
    return l.width < r.width * 0.7;
  }), 'the left side narrowed');
  // Swap sides.
  await send('tab:split-swap', a);
  assert.deepEqual(await until(() => L.main((_e, y) => { const s = global.lumio.tabs.split.state(); return s?.left === y ? s : null; }, b)), { left: b, right: a, ratio: 0.65 });
  // The session keeps the pair.
  await L.wait(600);
  const saved = await L.main(() => global.lumio.store.sessionWindows()[0].tabs.filter((t) => t.split).map((t) => [t.url.split('/').pop(), t.split.side]));
  assert.deepEqual(saved, [['right', 'left'], ['left', 'right']]);
});

test('split view: closing one side leaves the other with the whole page area; separating keeps the focused one', async () => {
  const pair = await L.main(() => global.lumio.tabs.split.state());
  await send('tab:close', pair.right);
  assert.ok(await until(() => L.main(() => !global.lumio.tabs.split.state())));
  const [view, slot] = await until(() => L.main(() => { const t = global.lumio.tabs; const b = t.active.view.getBounds(); return b.width === t.slot.width ? [b, t.slot] : null; }));
  assert.deepEqual(view, slot);
  assert.equal(await L.shell(`document.getElementById('split').hidden`), true);
  // A new pair from the tab menu's action, then separated.
  await open('third');
  const third = await L.main(() => global.lumio.tabs.activeId);
  await L.main((_e, id) => global.lumio.tabs.split.addToNew(id), third);
  assert.ok(await until(() => L.main(() => !!global.lumio.tabs.split.state())));
  assert.equal(await L.main(() => global.lumio.tabs.active.url), 'lumio://newtab/', 'a new tab page joins it, to pick from');
  await send('tab:split-separate', third);
  assert.ok(await until(() => L.main(() => !global.lumio.tabs.split.state())));
  assert.equal(await L.main(() => global.lumio.tabs.active.url), 'lumio://newtab/');
});
