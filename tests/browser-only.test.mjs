// Lumio AI works only in the browser: no tools for the computer itself (screen,
// mouse, keyboard, apps, shell, AppleScript) whatever the server lists, the
// steps tell the server the computer is off limits, links that would start
// another app are refused, and nothing in Lumio's windows and pages says it can
// control the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeAccount } from './fake-agent.mjs';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
require.cache[electronPath] ??= { id: electronPath, filename: electronPath, loaded: true, exports: {} };
const { AIController } = require('../main/ai/controller.js');
const { ChatStore } = require('../main/ai/chats.js');
const { buildSystemPrompt } = require('../main/ai/prompts.js');
const browser = require('../main/ai/tools/browser.js');
const { aiAtWork } = require('../main/ai/indicators.js');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const COMPUTER = ['computer_screenshot', 'computer_click', 'computer_move', 'computer_drag', 'computer_scroll', 'computer_type', 'computer_key', 'open_app', 'list_apps', 'run_shell', 'run_applescript'];

// An AI controller for one window, with no real tabs, on a stand-in server
// that lists `tools` (null: a server too old to list them).
function controller(tools) {
  const ended = [];
  const store = { settings: { reasoning: 'medium', approvalMode: 'bypass', appsOff: [] }, setSetting(k, v) { this.settings[k] = v; } };
  const account = fakeAccount((body) => (body.messages.some((m) => m.role === 'tool') ? { text: 'Done.' } : { calls: [{ name: 'run_shell', arguments: '{"command":"open -a \\"Microsoft Excel\\"","explanation":"Open Excel"}' }] }), { tools });
  const ai = new AIController({
    store,
    chats: new ChatStore(null),
    tabs: { active: null, tabs: [], displayUrl: () => '', get: () => null },
    emit: (channel, ev) => { if (ev?.type === 'end') ended.shift()?.(); },
    account,
  });
  const end = () => new Promise((resolve) => ended.push(resolve));
  return { ai, account, end };
}

for (const [what, tools] of [['a server that still lists the computer tools (0.6.7’s)', ['read_page', 'click', 'navigate', ...COMPUTER]], ['a server too old to list its tools', null]]) {
  test(`with ${what}, no computer tool is offered, the step says the computer is off, and a stray run_shell runs nothing`, async () => {
    const { ai, account, end } = controller(tools);
    assert.equal('macAvailable' in ai.state(), false);
    const ending = end();
    const sent = await ai.send({ text: 'Open Excel and make a budget' });
    assert.equal(sent.ok, true);
    await ending;
    assert.equal(account.bodies.length, 2);
    for (const body of account.bodies) {
      assert.deepEqual(body.tools.filter((t) => COMPUTER.includes(t)), []);
      assert.equal(body.context.computer, false);
    }
    assert.ok(account.bodies[0].tools.includes('read_page'));
    // The model asked for run_shell anyway: there's no such tool here.
    assert.match(account.bodies[1].messages.find((m) => m.role === 'tool').content, /^Error: there is no tool named "run_shell"/);
  });
}

test('the AI can’t open links that start another app (mailto:, Office’s desktop links), only web pages', async () => {
  const ctx = { tabs: { searchTemplate: () => 'https://www.google.com/search?q=%s', active: null, get: () => null, ensureView() {} } };
  const navigate = browser.tools.find((t) => t.name === 'navigate');
  const openTab = browser.tools.find((t) => t.name === 'open_tab');
  for (const url of ['mailto:team@example.com', 'MAILTO:team@example.com?subject=Hi']) {
    await assert.rejects(navigate.run({ url }, ctx), /can’t open other apps/, url);
    await assert.rejects(openTab.run({ url }, ctx), /can’t open other apps/, url);
  }
  // Web addresses pass that check (they only fail here because this stand-in has no tab).
  for (const url of ['https://excel.cloud.microsoft/', 'office.com', 'docs.google.com/spreadsheets', 'localhost:3000']) {
    await assert.rejects(navigate.run({ url }, ctx), /No tab is open/, url);
  }
  // Other apps' schemes typed as a URL become a web search, as in the address bar.
  await assert.rejects(navigate.run({ url: 'ms-excel:ofe|u|https://example.com/a.xlsx' }, ctx), /No tab is open/);
});

test('while Lumio AI works on a page (or a helper has the tab), it and what it opens can’t open other apps, until the task ends', () => {
  let running = true;
  const page = { id: 'calendar' };
  const w = { closed: false, ai: { isRunning: () => running }, indicator: { working: (wc) => running && wc === page } };
  const worked = { view: { webContents: page } };
  const held = aiAtWork(w, worked);
  assert.equal(typeof held, 'function');
  assert.equal(held(), true);
  assert.equal(aiAtWork(w, { view: { webContents: { id: 'mine' } } }), null, 'a tab Lumio hasn’t touched is the person’s');
  assert.equal(typeof aiAtWork(w, { view: { webContents: { id: 'helper' } }, agent: { name: 'Helper 1' } }), 'function', 'a helper’s tab');
  // A tab, pop-up or window that page opened (main/tabs.js passes it on); a pop-up has no AI of its own.
  const popup = { indicator: { bar: null, place() {}, raise() {} } };
  const zoom = { view: { webContents: { id: 'zoom' } }, aiOpener: held };
  assert.equal(aiAtWork(popup, zoom), held);
  assert.equal(aiAtWork(w, zoom), held);
  // The task ended: they're the person's again.
  running = false;
  assert.equal(held(), false);
  assert.equal(aiAtWork(w, worked), null);
  assert.equal(aiAtWork(popup, zoom), null);
});

test('a link the page tried to open in another app is reported once, so the AI doesn’t think the app opened', async () => {
  const snap = { title: 'Calendar', url: 'https://calendar.example/', viewport: '1200x800', scrollY: 0, scrollHeight: 800, lines: [], total: 0, meta: {}, text: '' };
  const wc = { isLoading: () => false, isDestroyed: () => false, getURL: () => snap.url, getTitle: () => snap.title, executeJavaScriptInIsolatedWorld: async () => snap };
  const tab = { id: 3, view: { webContents: wc }, url: snap.url, blockedApp: 'mailto' };
  const ctx = { tabs: { active: tab, activeId: 3, get: (id) => (id === 3 ? tab : null), ensureView() {}, activate() {} }, refs: new Map(), onPage() {} };
  const readPage = browser.tools.find((t) => t.name === 'read_page');
  const first = await readPage.run({}, ctx);
  assert.match(first.text, /Tab 3 tried to open a mailto: link in another app\. Lumio stays in the browser, so nothing opened: use the web version in a tab instead \(for email, the user’s webmail, like Gmail or Outlook on the web\)/);
  assert.doesNotMatch((await readPage.run({}, ctx)).text, /another app/, 'once');
  // Other tools' results say it too (here: "Page is now…" after go_back).
  tab.blockedApp = 'zoommtg';
  wc.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  const back = await browser.tools.find((t) => t.name === 'go_back').run({}, ctx);
  assert.match(back, /^Can't go back\. Page is now: "Calendar" — https:\/\/calendar\.example\/\nTab 3 tried to open a zoommtg: link in another app\..*"Join from your browser"/);
});

test('the prompt Lumio keeps for itself works in tabs and uses web apps', () => {
  const prompt = buildSystemPrompt({ activeTab: { id: 1, title: 'Home', url: 'https://example.com/' }, tabCount: 1, mode: 'auto' });
  assert.match(prompt, /only inside Lumio's browser tabs/);
  assert.match(prompt, /excel\.cloud\.microsoft/);
  assert.match(prompt, /Google Sheets/);
  assert.match(prompt, /can't do that from the browser/);
  assert.doesNotMatch(prompt, /computer_|open_app|run_shell|AppleScript|shell command|control the (Mac|PC|computer)/i);
});

// What people see: the AI panel, the window, Settings, the Stop bar, and their Spanish.
test('nothing Lumio shows says the AI can control the computer', () => {
  const files = [
    'renderer/ui/ai-panel.js', 'renderer/ui/shell.html', 'renderer/ui/aura.html', 'renderer/ui/aura.js',
    'renderer/pages/settings.html', 'renderer/pages/settings.js', 'renderer/pages/welcome.html', 'renderer/assets/i18n/es.js',
  ];
  const CLAIMS = /control(s|ling)? (your|the) (computer|Mac|PC|\{pc\})|controla(r|ndo)? tu (computadora|\{pc\})|using your computer|(anything|even|commands) on your computer|run(s|ning)? commands|AppleScript|computer control|control de la computadora|permission to do this|move the mouse|mueva el mouse|Help on my|apps are running|mac-permissions/i;
  const found = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => { if (CLAIMS.test(line)) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(found, []);
  assert.equal(fs.existsSync(path.join(ROOT, 'main/ai/tools/mac.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'main/ai/screen-aura.js')), false);
});
