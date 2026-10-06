// End-to-end tests for the power-user features in the real app: Name window
// (main/window-name.js), keyboard shortcuts (main/shortcuts.js), caret
// browsing (main/caret-browsing.js), force dark mode for web contents
// (main/force-dark.js) and protocol handlers (main/protocol-handlers.js).
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
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
const title = () => L.main(() => global.lumio.tabs.wc().getTitle());
const open = async (url, expectTitle) => {
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, url);
  assert.ok(await until(async () => (await title()).includes(expectTitle)), `"${expectTitle}" loaded`);
};
// The application menu item with this label (a plain object: label, accelerator, role…).
const menuItem = (label) => L.main((e, l) => {
  const find = (items) => {
    for (const i of items) {
      if (i.label === l) return { label: i.label, accelerator: i.accelerator || null, role: i.role || null, checked: i.checked, items: i.submenu?.items.map((x) => x.label) || [] };
      const sub = i.submenu && find(i.submenu.items);
      if (sub) return sub;
    }
    return null;
  };
  return find(e.Menu.getApplicationMenu().items);
}, label);

before(async () => {
  site = http.createServer((q, r) => {
    const name = new URL(q.url, 'http://x').pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1 id="h">${name}</h1><p id="p">Some words about ${name} to select.</p><a id="mail" href="mailto:sam@example.com?subject=Hi">Email Sam</a>`);
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

test('Name window: the box names the window; tabs don’t rename it; the Window menu and the session keep it', async () => {
  await open(`${base}/one`, 'Page one');
  await L.main(() => global.lumio.cmd.nameWindow());
  assert.ok(await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'namewindow')), 'the box opened');
  const typeName = (name) => L.main((_e, n) => global.lumio.current.overlay.webContents.executeJavaScript(
    `(() => { const i = document.getElementById('nw-name'); i.value = ${JSON.stringify(n)}; i.form.requestSubmit(); return true })()`), name);
  assert.ok(await until(() => L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`!!document.getElementById('nw-name')`))));
  await shot('power-01-name-window');
  await typeName('Research');
  assert.ok(await until(() => L.main(() => global.lumio.win.getTitle() === 'Research')), 'the window’s title is its name');
  assert.equal(await L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current)), null, 'the box closed');
  await open(`${base}/two`, 'Page two');
  await L.wait(300);
  assert.equal(await L.main(() => global.lumio.win.getTitle()), 'Research', 'switching tabs keeps the name');
  assert.ok(await until(() => L.main(() => global.lumio.store.sessionWindows()[0]?.name === 'Research')), 'saved with the session');
  const win = await menuItem('Window');
  assert.ok(win.items.includes('Name Window…'));
  if (process.platform === 'darwin') assert.match(String(win.role), /^window$/i, 'macOS lists the windows there, by name (main/menu.js role \'window\')');
  // An empty name goes back to the page's title.
  await L.main(() => global.lumio.cmd.nameWindow());
  assert.ok(await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'namewindow')));
  assert.ok(await until(() => L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`document.getElementById('nw-name')?.value === 'Research'`))), 'the box shows the name');
  await typeName('');
  assert.ok(await until(async () => (await L.main(() => global.lumio.win.getTitle())).includes('Page two')));
});

test('Keyboard shortcuts: Settings lists the commands, a new key goes into the menu right away, and Reset brings Lumio’s back', async () => {
  await open('lumio://settings/shortcuts', 'Keyboard shortcuts');
  assert.ok(await until(() => L.page(`document.querySelectorAll('.sc-item').length > 20`)), 'the commands are listed');
  await shot('power-02-shortcuts');
  const before = (await menuItem('New Tab')).accelerator;
  assert.equal(before, 'CmdOrCtrl+T');
  const res = await L.page(`lumioPage.invoke('page:shortcut-set', 'new-tab', 'CmdOrCtrl+Shift+Y', false)`);
  assert.equal(res.ok, true);
  assert.ok(await until(async () => /Shift/.test((await menuItem('New Tab')).accelerator) && /Y$/.test((await menuItem('New Tab')).accelerator)), 'the menu has the new key');
  const newTabTip = () => L.shell(`document.getElementById('newtab').title`);
  assert.ok(await until(async () => /^New Tab \(.*Y\)$/.test(await newTabTip())), `the + button's tooltip names the new keys: ${await newTabTip()}`);
  // Another command's keys ask first.
  const clash = await L.page(`lumioPage.invoke('page:shortcut-set', 'new-window', 'CmdOrCtrl+Shift+Y', false)`);
  assert.equal(clash.conflict.label, 'New Tab');
  // Kept after a restart: it's a setting.
  assert.ok(await until(() => L.main(() => /Y$/.test(global.lumio.store.settings.shortcuts?.['new-tab'] || ''))));
  await L.page(`lumioPage.invoke('page:shortcut-reset', null)`);
  assert.ok(await until(async () => (await menuItem('New Tab')).accelerator === 'CmdOrCtrl+T'), 'Lumio’s own key is back');
  assert.ok(await until(async () => /^New Tab \(.*T\)$/.test(await newTabTip())), 'and in the tooltip');
});

test('Caret browsing: F7 asks the first time, then every tab follows, and the arrow keys select text', async () => {
  // Stands in for the person's answer to the question.
  await L.main((e) => {
    global.__asked = [];
    global.__showMessageBox = e.dialog.showMessageBox;
    e.dialog.showMessageBox = async (_w, o) => { global.__asked.push(o.message); return { response: 0 }; };
  });
  try {
    assert.equal((await menuItem('Caret Browsing')).accelerator, 'F7');
    await open(`${base}/caret`, 'Page caret');
    await L.main(() => global.lumio.cmd.toggleCaretBrowsing());
    assert.ok(await until(() => L.main(() => global.lumio.store.settings.caretBrowsing === true)));
    assert.deepEqual(await L.main(() => global.__asked), ['Turn on caret browsing?']);
    const allOn = () => L.main(() => global.lumio.windows.flatMap((w) => w.tabs.tabs).filter((t) => t.view).every((t) => t.view.webContents.isCaretBrowsingEnabled()));
    assert.ok(await until(allOn), 'every open tab');
    assert.ok(await until(async () => (await menuItem('Caret Browsing')).checked === true), 'the View menu shows it');
    // A click puts the cursor in the text; Shift+Right selects from there.
    const at = JSON.parse(await L.page(`(() => { const r = document.getElementById('p').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) }) })()`));
    await L.main((_e, p) => {
      const wc = global.lumio.tabs.wc();
      wc.focus();
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }, at);
    await L.wait(200);
    for (let i = 0; i < 4; i++) await L.main(() => { const wc = global.lumio.tabs.wc(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['shift'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['shift'] }); });
    assert.ok(await until(async () => (await L.page(`getSelection().toString()`)).length >= 3), `selected: "${await L.page('getSelection().toString()')}"`);
    // A tab opened now has it too.
    await open(`${base}/later`, 'Page later');
    assert.equal(await L.main(() => global.lumio.tabs.wc().isCaretBrowsingEnabled()), true);
    // Off again, without asking.
    await L.main(() => global.lumio.cmd.toggleCaretBrowsing());
    assert.ok(await until(() => L.main(() => global.lumio.store.settings.caretBrowsing === false)));
    assert.equal((await L.main(() => global.__asked)).length, 1);
    assert.equal(await L.main(() => global.lumio.tabs.wc().isCaretBrowsingEnabled()), false);
  } finally {
    await L.main((e) => { e.dialog.showMessageBox = global.__showMessageBox; });
  }
});

test('Force dark: the switch waits for a relaunch, and Settings says so', async () => {
  await open('lumio://settings/#appearance', 'Settings');
  assert.ok(await until(() => L.page(`document.getElementById('force-dark') && document.getElementById('fd-relaunch').hidden`)));
  await L.page(`document.getElementById('force-dark').click(); true`);
  assert.ok(await until(() => L.page(`!document.getElementById('fd-relaunch').hidden`)), 'Relaunch shows');
  assert.ok(await until(() => L.main(() => global.lumio.store.settings.forceDarkPages === true)));
  await shot('power-03-force-dark-relaunch');
  // Not on in this run (it's a startup switch), so the theme choice still works.
  assert.equal(await L.page(`document.querySelector('input[name=appearance]').disabled`), false);
  await L.page(`document.getElementById('force-dark').click(); true`);
  assert.ok(await until(() => L.page(`document.getElementById('fd-relaunch').hidden`)));
  assert.equal(await L.main(() => global.lumio.store.settings.forceDarkPages), false);
});

test('Force dark: started with it on, light websites are drawn dark and Lumio is dark whatever Theme says', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-fd-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ forceDarkPages: true, appearance: 'light', onboarded: true }));
  const D = await launch({ profile });
  try {
    await until(() => D.main(() => !!global.lumio.tabs?.active), 15_000);
    assert.match(await D.main((e) => e.app.commandLine.getSwitchValue('blink-settings')), /forceDarkModeEnabled=true/);
    assert.deepEqual(await D.main((e) => [e.nativeTheme.themeSource, e.nativeTheme.shouldUseDarkColors]), ['dark', true], 'Lumio is dark');
    assert.equal((await D.main((e) => {
      const find = (items) => items.flatMap((i) => (i.label === 'Appearance' ? [i] : i.submenu ? find(i.submenu.items) : []));
      return find(e.Menu.getApplicationMenu().items)[0].submenu.items.map((i) => i.enabled);
    })).some(Boolean), false, 'View › Appearance waits');
    await D.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/white`);
    assert.ok(await until(() => D.main(() => global.lumio.tabs.wc().getTitle() === 'Page white')));
    await D.wait(500);
    // A pixel of the page's white background, as drawn.
    const rgb = await D.main(async () => {
      const img = await global.lumio.tabs.wc().capturePage({ x: 300, y: 300, width: 1, height: 1 });
      const b = img.toBitmap(); // BGRA
      return [b[2], b[1], b[0]];
    });
    assert.ok(rgb.every((v) => v < 60), `the white page is drawn dark (rgb ${rgb})`);
  } finally {
    await D.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Force dark: lumio://flags-lite’s old “Dark mode for all websites” choice moves to Settings › Appearance', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-fd-flag-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ flags: { forceDark: true, smoothScrolling: false }, onboarded: true }));
  const D = await launch({ profile });
  try {
    await until(() => D.main(() => !!global.lumio.tabs?.active), 15_000);
    assert.match(await D.main((e) => e.app.commandLine.getSwitchValue('blink-settings')), /forceDarkModeEnabled=true/, 'on from the first run');
    const s = await D.main(() => ({ on: global.lumio.store.settings.forceDarkPages, flags: global.lumio.store.settings.flags }));
    assert.equal(s.on, true, 'now the Appearance setting');
    assert.deepEqual(s.flags, { smoothScrolling: false }, 'the old flag is gone; the others stay');
  } finally {
    await D.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Protocol handlers: a site asks, Allow sends its mailto: links to it, Settings lists and removes it', async () => {
  await open(`${base}/mail`, 'Page mail');
  await L.page(`navigator.registerProtocolHandler('mailto', '/compose?to=%s'); true`);
  // The browser window asks in the address bar's chip and its bubble (batch 6; #permbar is only in pop-up windows).
  const bubble = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
  const asks = () => L.main(() => ((w) => w.overlayKind === 'permission' && w.overlayIn === w.overlaySeq)(global.lumio.current))
    .then((open) => open && bubble(`document.querySelector('.pb [data-d=allow]') && document.querySelector('.pb').innerText`));
  if (!(await until(async () => /open all email links/i.test(await asks() || '')))) {
    // Why not: the window's overlay, the chip, and where the shell's keyboard is.
    console.error('protocol handler, no bubble:', JSON.stringify(await L.main(async () => {
      const w = global.lumio.current;
      const shell = await w.win.webContents.executeJavaScript(`({ active: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(), omnibox: document.getElementById('omnibox').className, chip: document.getElementById('perm-chip').hidden ? null : document.getElementById('perm-chip').textContent })`).catch((e) => e.message);
      return { overlayKind: w.overlayKind, overlayIn: w.overlayIn, overlaySeq: w.overlaySeq, url: w.tabs.wc()?.getURL(), pageFocused: w.tabs.wc()?.isFocused(), shellFocused: w.win.webContents.isFocused(), shell, saved: global.lumio.store.settings.protocolHandlers || null };
    }).catch((e) => e.message)));
  }
  assert.ok(/open all email links/i.test(await asks() || ''), `the bubble asks: ${await asks()}`);
  assert.equal(await L.shell(`!document.getElementById('perm-chip').hidden`), true, 'the chip shows');
  await shot('power-04-protocol-handler-bubble');
  await bubble(`document.querySelector('.pb [data-d=allow]').click(); true`);
  assert.ok(await until(() => L.main(() => global.lumio.store.settings.protocolHandlers?.[0]?.allowed === true)));
  assert.equal(await L.main((_e, b) => global.lumio.store.settings.protocolHandlers[0].url, base), `${base}/compose?to=%s`);

  // A mailto: link opens the site's page in a new tab next to this one, when
  // the person clicks it (a script's click() alone opens nothing).
  const clickMail = async () => {
    const at = JSON.parse(await L.page(`(() => { const r = document.getElementById('mail').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) }) })()`));
    await L.main((_e, p) => {
      const wc = global.lumio.tabs.wc();
      wc.focus();
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }, at);
  };
  const tabsBefore = await L.main(() => global.lumio.tabs.tabs.length);
  await L.page(`document.getElementById('mail').click(); true`);
  await L.wait(800);
  assert.equal(await L.main(() => global.lumio.tabs.tabs.length), tabsBefore, 'no tab from a script');
  await clickMail();
  const want = `${base}/compose?to=${encodeURIComponent('mailto:sam@example.com?subject=Hi')}`;
  assert.ok(await until(() => L.main((_e, u) => global.lumio.tabs.tabs.some((t) => t.view?.webContents.getURL() === u), want)), 'the handler opened');
  assert.equal(await L.main(() => global.lumio.tabs.tabs.length), tabsBefore + 1);
  assert.ok(await L.main((_e, b) => global.lumio.tabs.tabs.some((t) => t.view?.webContents.getURL() === `${b}/mail`), base), 'the page with the link stays');

  // Settings › Privacy and security › Protocol handlers: listed, then removed.
  await open('lumio://settings/#protocol-handlers', 'Settings');
  assert.ok(await until(async () => /127\.0\.0\.1.*Opens all email links/s.test(await L.page(`document.getElementById('handler-list').innerText`))));
  await L.page(`document.querySelector('#handler-list [data-remove]').click(); true`);
  assert.ok(await until(() => L.main(() => (global.lumio.store.settings.protocolHandlers || []).length === 0)));
  // mailto: links aren't routed any more.
  await open(`${base}/mail2`, 'Page mail2');
  const count = await L.main(() => global.lumio.tabs.tabs.length);
  await clickMail();
  await L.wait(800);
  assert.equal(await L.main(() => global.lumio.tabs.tabs.length), count);
});
