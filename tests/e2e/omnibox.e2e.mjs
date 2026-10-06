// End-to-end tests for the address bar: inline autocomplete from typed
// addresses, switching to a tab in another window, the default search
// engine's suggestions (and none in Incognito), a site search chip, paste and
// go, removing a page with ⇧Delete, and adding a site search in Settings.
// Run: node --test tests/e2e/omnibox.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from '../../scripts/launch.mjs';

let L;
let site;
let base;
let suggestHits = 0;
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await L.wait(150);
  }
};
const title = () => L.main(() => global.lumio.tabs.wc().getTitle());
const waitTitle = async (t) => assert.ok(await until(async () => (await title()).includes(t)), `page "${t}" loaded`);

// The address bar, driven from inside the window's UI.
// On a Mac a window comes to the front a moment after focus(), and then
// gives the keyboard back to the view that last had it (often the page),
// which takes it from the address bar (main/tabs.js page-focus). So wait
// for the window to be in front before the bar takes the keyboard.
const focusBar = async () => {
  await L.main(() => { global.lumio.current.focus(); return true; });
  if (!(await until(() => L.main(() => global.lumio.current.win.isFocused()), 5000))) console.error('focusBar: the window is not in front:', JSON.stringify(await focusState()));
  await L.wait(200);
  await L.main(() => { global.lumio.current.win.webContents.focus(); return true; });
  if (!(await until(() => L.main(() => global.lumio.current.win.webContents.isFocused()), 5000))) console.error('focusBar: the window\'s UI has no keyboard:', JSON.stringify(await focusState()));
  await L.shell(`(() => { const a = document.getElementById('address'); a.blur(); a.focus(); return true })()`);
  await L.wait(300); // the shortcuts for chips arrive
};
// Which window, page and field have the keyboard (printed when a check times out).
const focusState = () => L.main(async () => {
  const w = global.lumio.current;
  const shell = await w.win.webContents.executeJavaScript(`({ active: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(), omnibox: document.getElementById('omnibox').className, value: document.getElementById('address').value })`).catch((e) => e.message);
  return { current: w.id, windows: global.lumio.windows.map((x) => ({ id: x.id, focused: x.win.isFocused(), overlayKind: x.overlayKind })), pageFocused: w.tabs.wc()?.isFocused(), shellFocused: w.win.webContents.isFocused(), shell };
}).catch((e) => e.message);
const typeText = (text) => L.shell(`(() => {
  const a = document.getElementById('address');
  for (const ch of ${JSON.stringify(text)}) {
    const at = a.selectionStart;
    a.value = a.value.slice(0, at) + ch;
    a.setSelectionRange(at + 1, at + 1);
    a.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
  }
  return true;
})()`);
const clearBar = () => L.shell(`(() => { const a = document.getElementById('address'); a.value = ''; return true })()`);
const press = (key, mods = {}) => L.shell(`(() => { document.getElementById('address').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} })); return true })()`);
const bar = () => L.shell(`(() => { const a = document.getElementById('address'); return { value: a.value, start: a.selectionStart, end: a.selectionEnd, chip: document.getElementById('omni-chip').hidden ? null : document.getElementById('omni-chip').textContent } })()`);
// The dropdown's rows, as drawn.
const rows = () => L.main(() => {
  const w = global.lumio.current;
  if (w.overlayKind !== 'suggest') return [];
  return w.overlay.webContents.executeJavaScript(`[...document.querySelectorAll('.row')].map((r) => ({ type: r.classList[1], remote: r.classList.contains('remote'), text: r.innerText }))`);
});

before(async () => {
  site = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/suggest') {
      suggestHits++;
      const qq = u.searchParams.get('q') || '';
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify([qq, [`${qq} one`, `${qq} two`]]));
      return;
    }
    if (u.pathname === '/search') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(`<title>Results for ${u.searchParams.get('q')}</title><h1>results</h1>`);
      return;
    }
    const name = u.pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1>`);
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

test('an address typed once completes inline next time, and Enter goes there', async () => {
  await L.main((_e, url) => { global.lumio.omnibox.open(global.lumio.current, { input: url }); return true; }, `${base}/alpha`);
  await waitTitle('Page alpha');
  assert.equal(await L.main((_e, url) => global.lumio.omnibox.typed[url]?.n, `${base}/alpha`), 1);
  await focusBar();
  await clearBar();
  await typeText('127.0.0');
  const host = base.replace('http://', '');
  assert.ok(await until(async () => (await bar()).value === host), `completed to ${host}: ${JSON.stringify(await bar())}`);
  const b = await bar();
  assert.deepEqual([b.start, b.end], [7, host.length], 'the added part is selected');
  await press('Enter');
  await waitTitle('Page home');
});

test('an open tab in another window is offered, and picking it switches there', async () => {
  try {
    await L.main((_e, url) => { global.lumio.createWindow({ urls: [url] }); return true; }, `${base}/beta`);
    assert.ok(await until(() => L.main(() => global.lumio.windows.length === 2 && global.lumio.tabs.wc()?.getTitle() === 'Page beta')));
    const other = await L.main(() => global.lumio.current.id);
    // A new window comes to the front once its UI has drawn (createWindow:
    // focus() on ready-to-show), which can be after its page has loaded. If
    // the first window were brought forward before that, the new one would
    // take the front back, and the bar typed into would be the one whose own
    // tab is "Page beta" (never offered as a switch): CI run 5.
    if (!(await until(() => L.main((_e, id) => { const w = global.lumio.windows.find((x) => x.id === id); return !!w && w.win.isVisible(); }, other)))) console.error('the new window never showed:', JSON.stringify(await focusState()));
    await L.wait(300);
    const first = await L.main(() => global.lumio.windows[0].id);
    await L.main(() => { global.lumio.windows[0].focus(); return true; });
    if (!(await until(() => L.main((_e, id) => global.lumio.current.id === id && global.lumio.current.win.isFocused(), first), 5000))) console.error('the first window is not in front:', JSON.stringify(await focusState()));
    await focusBar();
    assert.equal(await L.main(() => global.lumio.current.id), first, 'typing in the first window');
    await clearBar();
    await typeText('beta');
    assert.ok(await until(async () => (await rows()).some((r) => r.type === 'tab' && /Switch to this tab/.test(r.text))), `a "Switch to this tab" row: ${JSON.stringify({ rows: await rows(), focus: await focusState() })}`);
    await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector('.row.tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); true`));
    assert.ok(await until(async () => (await L.main(() => global.lumio.current.id)) === other), 'the other window is in front');
    await L.main(() => { global.lumio.current.close(); return true; });
    assert.ok(await until(() => L.main(() => global.lumio.windows.length === 1)));
  } finally {
    // Only the first window stays for the next test, even after a failure.
    await L.main(() => { const [first, ...rest] = global.lumio.windows; for (const w of rest) w.close(); if (first) first.focus(); return true; });
    await until(() => L.main(() => global.lumio.windows.length === 1));
  }
});

test('the search engine’s suggestions show while typing a search, never in Incognito', async () => {
  await L.main((_e, b) => {
    const s = global.lumio.store;
    s.setSetting('searchEngines', [{ id: 'local', name: 'Local', keyword: 'loc', url: `${b}/search?q=%s`, suggestUrl: `${b}/suggest?q=%s` }]);
    s.setSetting('searchEngine', 'local');
    return true;
  }, base);
  await focusBar();
  await clearBar();
  await typeText('pizza');
  assert.ok(await until(async () => (await rows()).filter((r) => r.remote).map((r) => r.text).join('|') === 'pizza one|pizza two'), JSON.stringify(await rows()));
  await press('Enter');
  await waitTitle('Results for pizza');

  // Incognito: the same typing asks nobody.
  await L.main(() => { global.lumio.createWindow({ incognito: true }); return true; });
  assert.ok(await until(() => L.main(() => global.lumio.current.incognito)));
  const hits = suggestHits;
  await focusBar();
  await clearBar();
  await typeText('pasta');
  assert.ok(await until(async () => (await rows()).length > 0));
  await L.wait(800);
  assert.equal(suggestHits, hits, 'no request from Incognito');
  await L.main(() => { global.lumio.current.close(); return true; });
  assert.ok(await until(() => L.main(() => global.lumio.windows.every((w) => !w.incognito))));
});

test('"loc " turns the bar into a site search chip, and Enter searches there', async () => {
  await focusBar();
  await clearBar();
  await typeText('loc ');
  assert.equal((await bar()).chip, 'Search Local');
  await typeText('cats');
  await L.wait(300);
  await press('Enter');
  await waitTitle('Results for cats');
  assert.equal((await bar()).chip, null, 'the chip goes after searching');
  await L.main(() => { global.lumio.store.setSetting('searchEngine', 'google'); global.lumio.store.setSetting('searchEngines', undefined); return true; });
});

test('paste and go (⌘⇧V / Ctrl+Shift+V) opens what’s on the clipboard', async () => {
  await L.main((e, url) => { e.clipboard.writeText(url); return true; }, `${base}/gamma`);
  await focusBar();
  await press('V', process.platform === 'darwin' ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true });
  await waitTitle('Page gamma');
});

test('⇧Delete removes a page from history', async () => {
  await focusBar();
  await clearBar();
  await typeText('gamma');
  assert.ok(await until(async () => (await rows()).some((r) => r.type === 'history' && /Page gamma/.test(r.text))));
  const index = (await rows()).findIndex((r) => r.type === 'history' && /Page gamma/.test(r.text));
  for (let i = 0; i < index; i++) await press('ArrowDown');
  await press('Delete', { shiftKey: true });
  assert.ok(await until(() => L.main((_e, url) => !global.lumio.store.history().some((h) => h.url === url), `${base}/gamma`)));
  await press('Escape');
  await press('Escape');
});

test('Settings › Search engine: add a site search', async () => {
  await L.main(() => { global.lumio.tabs.navigate('lumio://settings/#search'); return true; });
  assert.ok(await until(async () => (await L.page(`document.querySelectorAll('#engine option').length`)) >= 4));
  await L.page(`document.getElementById('se-manage').click(); document.getElementById('se-add').click(); true`);
  await L.page(`(() => {
    const f = document.querySelector('.se-form');
    f.querySelector('[name=name]').value = 'MDN';
    f.querySelector('[name=keyword]').value = 'mdn';
    f.querySelector('[name=url]').value = 'https://developer.mozilla.org/en-US/search?q=%s';
    f.requestSubmit();
    return true;
  })()`);
  assert.ok(await until(() => L.main(() => (global.lumio.store.settings.searchEngines || []).some((e) => e.keyword === 'mdn'))));
  assert.ok(await until(async () => /MDN/.test(await L.page(`document.getElementById('se-custom').innerText`))));
  assert.ok(await L.main(() => (global.lumio.store.settings.searchEngines || []).some((e) => e.keyword === 'yt')), 'YouTube is still there');
});
