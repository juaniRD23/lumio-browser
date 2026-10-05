// "Leave site?" and the other dialogs that belong to a tab (main/tabs.js),
// with stand-in pages: when closing, reloading or leaving a page asks, what
// Leave and Cancel do, Lumio AI going back or closing a tab, closing a window
// page by page, and the tab's queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TabManager } = require('../main/tabs.js');
const { tools } = require('../main/ai/tools/browser.js');

const tick = () => new Promise((r) => setImmediate(r));
const event = (extra = {}) => ({ ...extra, preventDefault() { this.defaultPrevented = true; } });

// A page that may have a beforeunload that asks (`asks`), like Chromium's:
// closing or navigating runs it, and Electron's will-prevent-unload decides.
function fakePage(url) {
  const wc = new EventEmitter();
  Object.assign(wc, {
    url, asks: false, destroyed: false, crashed: false, calls: [],
    getURL: () => wc.url,
    getTitle: () => 'Page',
    isDestroyed: () => wc.destroyed,
    isCrashed: () => wc.crashed,
    isLoading: () => false,
    focus() {},
    setWindowOpenHandler() {},
    executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => { wc.calls.push(['script', code]); return null; },
    forcefullyCrashRenderer: () => wc.calls.push(['crash']),
    navigationHistory: {
      canGoBack: () => true, canGoForward: () => false,
      getAllEntries: () => [{ url: 'https://before.example/' }, { url: wc.url }], getActiveIndex: () => 1,
      goBack: () => wc.leave('back', () => wc.go('https://before.example/')),
    },
    // Runs beforeunload: true when the page may go.
    beforeunload() {
      if (!wc.asks) return true;
      const e = event();
      wc.emit('will-prevent-unload', e);
      return !!e.defaultPrevented;
    },
    leave(what, then) { wc.calls.push([what]); if (wc.beforeunload()) then(); },
    go(to) {
      wc.emit('did-start-navigation', { url: to, isMainFrame: true, isSameDocument: false });
      wc.url = to;
      wc.emit('did-navigate', event(), to);
    },
    loadURL: async (to) => wc.leave('load', () => wc.go(to)),
    reload: () => wc.leave('reload', () => wc.go(wc.url)),
    close(opts) {
      wc.calls.push(['close', !!opts?.waitForBeforeUnload]);
      if (opts?.waitForBeforeUnload && !wc.beforeunload()) return;
      setImmediate(() => { if (!wc.destroyed) { wc.destroyed = true; wc.emit('destroyed'); } });
    },
    // The person clicks or types in the page.
    touch() { wc.emit('input-event', event(), { type: 'mouseDown' }); },
  });
  return wc;
}

function setup(extraHooks = {}) {
  const children = [];
  const win = { contentView: { children, addChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); children.push(v); }, removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); } }, getContentSize: () => [1200, 800], setFullScreen() {} };
  const closed = [];
  let dialogSyncs = 0;
  // The window redraws the dialog view when the tab's queue changes or you switch tabs.
  const hooks = { onTabClosed: (_m, e) => closed.push(e.url), onDialogs: () => { dialogSyncs++; }, onActivated: () => { dialogSyncs++; }, ...extraHooks };
  const m = new TabManager({ win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks, incognito: true });
  let nextId = 100;
  const add = (url, { active = true } = {}) => {
    const wc = fakePage(url);
    const view = { webContents: wc, setBackgroundColor() {}, setVisible() {}, setBounds() {}, getBounds: () => ({ x: 0, y: 80, width: 1200, height: 720 }), setBorderRadius() {} };
    const tab = { id: nextId++, owner: m, view, url, title: url, pinned: false };
    m.tabs.push(tab);
    children.push(view);
    m.wire(tab);
    if (active || !m.activeId) m.activate(tab.id);
    return { tab, wc };
  };
  return { m, add, closed, syncs: () => dialogSyncs };
}

const leaveDialog = (tab) => tab.dialogs?.find((d) => d.spec.kind === 'leave');

test('a page you never used, or a Lumio page, closes at once without asking', () => {
  const { m, add, closed } = setup();
  const a = add('https://quiet.example/');
  const b = add('lumio://newtab/');
  a.wc.asks = true;
  b.wc.touch();
  m.close(a.tab.id);
  m.close(b.tab.id);
  assert.equal(m.tabs.length, 0);
  assert.deepEqual(a.wc.calls, [['close', false]], 'no beforeunload');
  assert.deepEqual(closed, ['https://quiet.example/']);
});

test('a page you used runs its beforeunload; it closes when it doesn’t ask', async () => {
  const { m, add } = setup();
  const a = add('https://news.example/');
  a.wc.touch();
  m.close(a.tab.id);
  assert.equal(m.tabs.length, 1, 'still there while the page answers');
  assert.deepEqual(a.wc.calls, [['close', true]]);
  m.close(a.tab.id); // a second click while it closes does nothing
  await tick(); await tick();
  assert.equal(m.tabs.length, 0);
  assert.equal(a.tab.dialogs?.length || 0, 0);
});

test('"Leave site?": Cancel keeps the tab, Leave closes it without asking again', async () => {
  const { m, add, closed } = setup();
  const a = add('https://editor.example/doc');
  add('https://other.example/'); // the active tab
  a.wc.touch();
  a.wc.asks = true;
  m.close(a.tab.id);
  const d = leaveDialog(a.tab);
  assert.ok(d, 'asked in its tab');
  assert.equal(m.activeId, a.tab.id, 'its tab comes forward');
  assert.deepEqual([d.spec.title, d.spec.message, d.spec.buttons.map((b) => b.label), d.spec.cancel], ['Leave site?', 'Changes you made may not be saved.', ['Cancel', 'Leave'], 'cancel']);
  m.answer(a.tab, d.id, { button: 'cancel' });
  await tick();
  assert.equal(m.tabs.includes(a.tab), true);
  assert.equal(a.tab.closing, null);

  m.close(a.tab.id);
  m.answer(a.tab, leaveDialog(a.tab).id, { button: 'leave' });
  await tick(); await tick(); await tick();
  assert.equal(m.tabs.includes(a.tab), false);
  assert.deepEqual(a.wc.calls.filter(([c]) => c === 'close'), [['close', true], ['close', true], ['close', false]]);
  assert.deepEqual(closed, ['https://editor.example/doc']);
});

test('reloading or going somewhere asks first; Leave does it, without a second question', async () => {
  const { m, add } = setup();
  const a = add('https://form.example/');
  a.wc.touch();
  a.wc.asks = true;
  m.reload();
  let d = leaveDialog(a.tab);
  assert.deepEqual([d.spec.title, d.spec.buttons.at(-1).label], ['Reload site?', 'Reload']);
  m.answer(a.tab, d.id, { button: 'leave' });
  await tick();
  assert.deepEqual(a.wc.calls, [['reload'], ['reload']]);
  assert.equal(a.tab.dialogs.length, 0, 'asked once');

  a.wc.touch();
  m.navigate('https://next.example/');
  d = leaveDialog(a.tab);
  assert.equal(d.spec.title, 'Leave site?');
  assert.equal(a.tab.url, 'https://next.example/');
  m.answer(a.tab, d.id, { button: 'cancel' });
  await tick();
  assert.equal(a.wc.url, 'https://form.example/', 'stayed');
  assert.equal(a.tab.url, 'https://form.example/', 'the address bar shows the page you stayed on');
  a.wc.touch();
  m.back();
  assert.ok(leaveDialog(a.tab), 'back asks too');
});

test('a link the page follows itself is caught and asked about; Leave sends the page there', async () => {
  const { add } = setup();
  const a = add('https://form.example/');
  a.wc.touch();
  a.wc.asks = true;
  // The page's own beforeunload, before it navigates (a link click):
  assert.equal(a.wc.beforeunload(), true, 'let through, to see where it goes');
  const nav = event({ url: 'https://elsewhere.example/page' });
  a.wc.emit('will-navigate', nav);
  assert.equal(nav.defaultPrevented, true, 'stopped until you answer');
  const d = leaveDialog(a.tab);
  assert.equal(d.spec.title, 'Leave site?');
  a.tab.owner.answer(a.tab, d.id, { button: 'leave' });
  await tick();
  assert.deepEqual(a.wc.calls.at(-1), ['script', 'location.assign("https://elsewhere.example/page")']);
  assert.ok(Date.now() - a.tab.allowUnload < 1000, 'and its beforeunload won’t ask again (for a moment)');
  // A later navigation, long after, isn't caught.
  const later = event({ url: 'https://x.example/' });
  a.wc.emit('will-navigate', later);
  assert.equal(later.defaultPrevented, undefined);
});

test('a page that keeps leaving by itself can’t push away “Leave site?” about closing it, or ask again without a click', async () => {
  const { m, add } = setup();
  const a = add('https://trap.example/');
  a.wc.touch();
  a.wc.asks = true;
  m.close(a.tab.id);
  const d = leaveDialog(a.tab);
  assert.ok(d, 'closing asks');
  // The page tries to go somewhere again and again while you're asked.
  for (let i = 0; i < 3; i++) {
    assert.equal(a.wc.beforeunload(), false, 'the page just stays');
    a.wc.emit('will-navigate', event({ url: `https://trap.example/${i}` }));
  }
  assert.equal(leaveDialog(a.tab), d, 'the question about closing is still the one shown');
  m.answer(a.tab, d.id, { button: 'leave' });
  await tick(); await tick(); await tick();
  assert.equal(m.tabs.includes(a.tab), false, 'and Leave closes it');

  // Its own navigations ask once per click or key press in the page.
  const b = add('https://loop.example/');
  b.wc.touch();
  b.wc.asks = true;
  assert.equal(b.wc.beforeunload(), true);
  const nav = event({ url: 'https://loop.example/next' });
  b.wc.emit('will-navigate', nav);
  assert.equal(nav.defaultPrevented, true);
  m.answer(b.tab, leaveDialog(b.tab).id, { button: 'cancel' });
  await tick();
  assert.equal(b.wc.beforeunload(), false, 'no click since it asked: the page stays, without asking');
  assert.equal(b.tab.dialogs.length, 0);
  b.wc.touch();
  assert.equal(b.wc.beforeunload(), true, 'after a click it may ask again');
  b.wc.emit('will-navigate', event({ url: 'https://loop.example/next' }));
  assert.ok(leaveDialog(b.tab));
});

test('a form you send leaves without asking, so what you typed still goes; Esc isn’t using the page', () => {
  const { add } = setup();
  const a = add('https://shop.example/checkout');
  a.wc.touch();
  a.wc.asks = true;
  a.tab.sentForm = Date.now(); // preload/internal.js saw the person send it
  assert.equal(a.wc.beforeunload(), true);
  const post = event({ url: 'https://shop.example/pay' });
  a.wc.emit('will-navigate', post);
  assert.equal(post.defaultPrevented, undefined, 'not stopped: the POST goes as it is');
  assert.equal(a.tab.dialogs?.length || 0, 0);
  // Esc never counts as using a page (it only ever closes things).
  const b = add('https://quiet.example/');
  b.wc.emit('before-input-event', event(), { type: 'keyDown', key: 'Escape' });
  b.wc.emit('input-event', event(), { type: 'rawKeyDown' });
  assert.equal(!!b.tab.touched, false);
  b.wc.emit('before-input-event', event(), { type: 'keyDown', key: 'a' });
  assert.equal(b.tab.touched, true, 'other keys do');
});

test('a new page starts with no dialogs “in a row” and none blocked; waiting on an alert in another tab of its process isn’t “unresponsive”', () => {
  let shared = false;
  const { add } = setup({ dialogInProcess: () => shared });
  const a = add('https://alerts.example/');
  a.tab.dialogsBlocked = new Set(['https://alerts.example']);
  a.tab.dialogStreak = { origin: 'https://alerts.example', count: 3, at: Date.now() };
  a.wc.go('https://alerts.example/next');
  assert.equal(a.tab.dialogsBlocked, null);
  assert.equal(a.tab.dialogStreak, null);
  shared = true;
  a.wc.emit('unresponsive');
  assert.equal(a.tab.dialogs?.length || 0, 0, 'its process is waiting on another tab’s alert()');
  shared = false;
  a.wc.emit('unresponsive');
  assert.equal(a.tab.dialogs[0].spec.kind, 'unresponsive');
});

test('Lumio AI is told about a dialog the page shows, and never waits on a page stopped by its alert()', async () => {
  const { m, add } = setup();
  const tool = (name) => tools.find((t) => t.name === name);
  const { pageContext } = require('../main/ai/tools/browser.js');
  const ctx = { tabs: m, refs: new Map() };
  const a = add('https://confirm.example/');
  // A page script that never finishes: the page is stopped on its own confirm().
  a.wc.executeJavaScriptInIsolatedWorld = () => new Promise(() => {});
  const reading = tool('read_page').run({ tab_id: a.tab.id }, ctx);
  m.ask(a.tab, { kind: 'js', title: 'confirm.example says', buttons: [{ id: 'cancel' }, { id: 'ok', primary: true }], cancel: 'cancel' });
  await assert.rejects(reading, /showing a message from the page, which only the user can answer/);
  await assert.rejects(tool('read_page').run({ tab_id: a.tab.id }, ctx), /only the user can answer/, 'and before it starts');
  assert.deepEqual(await pageContext(m, a.tab), { tabId: a.tab.id, title: 'Page', url: 'https://confirm.example/', text: '', favicon: undefined }, '"Include this page" skips its text');
  // "Leave site?" after its own navigation: the result says so.
  const b = add('https://draft.example/');
  b.wc.touch();
  b.wc.asks = true;
  const went = await tool('navigate').run({ url: 'https://elsewhere.example/', tab_id: b.tab.id }, ctx);
  assert.match(went, /draft\.example[\s\S]*showing "Leave site\?" \(the page has unsaved changes\), which only the user can answer/);
});

test('a helper AI’s tab never asks', () => {
  const { m, add } = setup();
  const a = add('https://shop.example/', { active: false });
  a.wc.touch();
  a.wc.asks = true;
  a.tab.agent = { name: 'Helper 1' };
  m.reload(false, a.tab.id);
  assert.equal(a.tab.dialogs?.length || 0, 0);
  assert.deepEqual(a.wc.calls, [['reload']], 'went ahead');
  m.close(a.tab.id, { force: true });
  assert.equal(m.tabs.includes(a.tab), false);
});

test('Lumio AI goes through the same path: going back asks first, and closing says when the page is asking', async () => {
  const { m, add } = setup();
  const tool = (name) => tools.find((t) => t.name === name);
  const ctx = { tabs: m };
  const quiet = add('https://read.example/');
  const a = add('https://form.example/');
  a.wc.touch();
  a.wc.asks = true;
  // Back: the page's beforeunload asks the person; Lumio AI doesn't get past it.
  const back = await tool('go_back').run({ tab_id: a.tab.id }, ctx);
  assert.match(back, /form\.example/, 'still on the page');
  assert.equal(leaveDialog(a.tab)?.spec.title, 'Leave site?');
  m.answer(a.tab, leaveDialog(a.tab).id, { button: 'cancel' });
  await tick();
  assert.equal(a.wc.url, 'https://form.example/');
  // Closing: the tab stays until the person answers, and the AI is told so.
  const closing = await tool('close_tab').run({ tab_id: a.tab.id }, ctx);
  assert.equal(closing, `Tab ${a.tab.id} is asking the user to confirm leaving the page; it closes if they agree.`);
  assert.ok(m.tabs.includes(a.tab));
  m.answer(a.tab, leaveDialog(a.tab).id, { button: 'cancel' });
  await tick();
  assert.ok(m.tabs.includes(a.tab), 'Cancel keeps it');
  // A page nobody used closes at once.
  assert.equal(await tool('close_tab').run({ tab_id: quiet.tab.id }, ctx), `Closed tab ${quiet.tab.id}.`);
  assert.equal(m.tabs.includes(quiet.tab), false);
});

test('closing the window asks page by page; staying keeps every tab (pages that agreed sleep)', async () => {
  const { m, add } = setup();
  const used = add('https://mail.example/');
  const draft = add('https://docs.example/draft');
  const unused = add('https://read.example/');
  used.wc.touch();
  draft.wc.touch();
  draft.wc.asks = true;
  assert.equal(m.anyMayAsk(), true);
  const first = m.confirmLeaveAll();
  await tick(); await tick();
  const d = leaveDialog(draft.tab);
  assert.ok(d, 'the draft asks');
  m.answer(draft.tab, d.id, { button: 'cancel' });
  assert.equal(await first, false);
  assert.equal(m.tabs.length, 3, 'all tabs still there');
  assert.equal(used.tab.view, null, 'the page that agreed is asleep…');
  assert.equal(used.tab.pendingUrl, 'https://mail.example/', '…and comes back where it was');
  assert.ok(used.tab.savedHistory.entries.length);
  assert.ok(draft.tab.view && !draft.wc.destroyed, 'the page you stayed on is untouched');
  assert.ok(unused.tab.view && !unused.wc.destroyed);

  const second = m.confirmLeaveAll();
  m.answer(draft.tab, leaveDialog(draft.tab).id, { button: 'leave' });
  assert.equal(await second, true);
  assert.equal(m.anyMayAsk(), false, 'nothing left to ask: the window can close');
  assert.equal(m.tabs.length, 3, 'the session still has every tab');
});

test('a page showing its own alert closes without asking, and its alert is answered', async () => {
  const { m, add } = setup();
  const a = add('https://alerty.example/');
  a.wc.touch();
  a.wc.asks = true;
  const answered = m.ask(a.tab, { kind: 'js', title: 'alerty.example says', buttons: [{ id: 'ok', label: 'OK', primary: true }], cancel: 'ok' });
  m.close(a.tab.id);
  assert.equal(m.tabs.length, 0);
  assert.deepEqual(await answered, { button: 'ok', values: {}, checked: false, dismissed: true });
});

test('"Page unresponsive": Wait, Exit page, and it goes away when the page recovers', async () => {
  const { m, add } = setup();
  const a = add('https://busy.example/');
  a.wc.emit('unresponsive');
  let d = a.tab.dialogs[0];
  assert.deepEqual([d.spec.title, d.spec.message], ['Page unresponsive', 'You can wait for it to become responsive or exit the page.']);
  assert.deepEqual(d.spec.buttons.map((b) => [b.label, !!b.primary]), [['Exit page', false], ['Wait', true]]);
  a.wc.emit('unresponsive');
  assert.equal(a.tab.dialogs.length, 1, 'asked once');
  a.wc.emit('responsive');
  assert.equal(a.tab.dialogs.length, 0);
  a.wc.emit('unresponsive');
  d = a.tab.dialogs[0];
  m.answer(a.tab, d.id, { button: 'exit' });
  await tick();
  assert.deepEqual(a.wc.calls.at(-1), ['crash']);
  // Waiting on its own alert isn't being stuck.
  m.ask(a.tab, { kind: 'js', buttons: [{ id: 'ok', label: 'OK' }], cancel: 'ok' });
  a.wc.emit('unresponsive');
  assert.deepEqual(a.tab.dialogs.map((x) => x.spec.kind), ['js']);
});

test('dialogs queue per tab; only the tab you’re on shows one; answers are checked', async () => {
  const { m, add, syncs } = setup();
  const a = add('https://a.example/');
  const b = add('https://b.example/', { active: false });
  const before = syncs();
  const fromB = m.ask(b.tab, { kind: 'auth', fields: [{ name: 'username' }, { name: 'password' }], buttons: [{ id: 'cancel' }, { id: 'signin', primary: true }], cancel: 'cancel' });
  assert.equal(syncs(), before, 'a background tab waits until you open it');
  m.activate(b.tab.id);
  assert.ok(syncs() > before);
  const d = b.tab.dialogs[0];
  m.answer(b.tab, d.id, { button: 'delete-everything' });
  assert.equal(b.tab.dialogs.length, 1, 'a button the dialog doesn’t have is ignored');
  m.answer(b.tab, d.id, { button: 'signin', values: { username: 'ada', password: 'pw', extra: 'nope' }, checked: true });
  assert.deepEqual(await fromB, { button: 'signin', values: { username: 'ada', password: 'pw' }, checked: false });
  // A tab that's gone answers at once.
  m.close(a.tab.id);
  assert.deepEqual(await m.ask(a.tab, { kind: 'js', buttons: [{ id: 'ok' }], cancel: 'ok' }), { button: 'ok', values: {}, checked: false, dismissed: true });
});

test('"Not secure" in the address bar: on the certificate warning, and on a site you went past it for', () => {
  const certs = require('../main/cert-errors.js');
  const { m, add } = setup();
  const warn = add('lumio://error/cert.html?code=-202&desc=ERR_CERT_AUTHORITY_INVALID&url=https%3A%2F%2Fself.example%2F');
  const past = add('https://past.example/page');
  const fine = add('https://fine.example/');
  certs.allow(m.session, 'past.example', 'sha256/x');
  const notSecure = Object.fromEntries(m.state().tabs.map((t) => [t.url, t.notSecure]));
  assert.deepEqual(notSecure, { 'https://self.example/': true, 'https://past.example/page': true, 'https://fine.example/': false });
  assert.ok(warn && past && fine);
});
