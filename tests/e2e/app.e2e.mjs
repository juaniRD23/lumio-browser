// End-to-end tests: launch the real app (throwaway profile), drive it, and
// check the browser, the AI panel and the agent against a stand-in Lumio
// server (the AI runs on the person's Lumio plan; here, the Free plan).
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from '../../scripts/launch.mjs';
import { startMockLumio } from '../mock-lumio.mjs';

const FIX = path.join(root, 'tests', 'fixtures');
const SHOTS = process.env.LUMIO_SHOTS;
let L;
let site;
let siteUrl;
let lumio;

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await L.wait(200);
  }
};
const ask = async (text) => {
  await L.shell(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('send').click(); return true })()`);
  await until(() => L.main(() => global.lumio.ai.isRunning()), 3000);
};
const lastReply = () => L.shell(`[...document.querySelectorAll('.msg.ai')].at(-1)?.innerText || ''`);
const idle = () => until(async () => !(await L.main(() => global.lumio.ai.isRunning())), 30_000);

before(async () => {
  site = http.createServer((q, r) => {
    const f = path.join(FIX, q.url === '/' ? 'article.html' : q.url.split('?')[0]);
    if (!f.startsWith(FIX) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(fs.readFileSync(f));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  lumio = await startMockLumio({ plan: 'free' });
  L = await launch({ env: { LUMIO_ACCOUNT_BASE: lumio.base, LUMIO_AI_BASE: lumio.base } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(800);
});

after(async () => {
  await L?.close();
  site?.close();
  lumio?.server.close();
});

test('opens on the Lumio new tab page with the AI panel', async () => {
  const url = await L.main(() => global.lumio.tabs.wc().getURL());
  assert.equal(url, 'lumio://newtab/');
  assert.match(await L.page('document.body.innerText'), /Lumio/);
  assert.equal(await L.shell(`document.body.classList.contains('panel-closed')`), false);
  await shot('01-newtab');
});

test('the AI panel slides open and closed, and the page follows it frame by frame', async () => {
  // Samples the page view's width while the panel animates.
  const slide = (button) => L.main(async (_e, btn) => {
    const w = global.lumio.current;
    const widths = new Set();
    const t0 = Date.now();
    w.win.webContents.executeJavaScript(`document.getElementById('${btn}').click()`);
    while (Date.now() - t0 < 700) { widths.add(w.tabs.active.view.getBounds().width); await new Promise((r) => setTimeout(r, 12)); }
    return [...widths];
  }, button);
  const closing = await slide('panel-close');
  assert.ok(closing.length >= 6, `page widened in steps while closing (${closing.join(', ')})`);
  assert.equal(await L.shell(`getComputedStyle(document.getElementById('panel')).visibility`), 'hidden');
  const opening = await slide('ai-toggle');
  assert.ok(opening.length >= 6, `page narrowed in steps while opening (${opening.join(', ')})`);
  assert.equal(await L.shell(`Math.round(document.getElementById('panel').getBoundingClientRect().width)`), 380);
});

test('omnibox navigates, and web pages cannot reach internal pages', async () => {
  await L.shell(`(() => { const a = document.getElementById('address'); a.focus(); a.value = ${JSON.stringify(siteUrl + '/form.html')}; a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`);
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Pizza'));
  assert.match(await L.main(() => global.lumio.tabs.wc().getTitle()), /Pizza Order/);
  // A website must not get the internal bridge or navigate to lumio:// pages.
  assert.equal(await L.page('typeof window.lumioPage'), 'undefined');
  assert.equal(await L.page('typeof window.lumio'), 'undefined');
  await L.page(`location.href = 'lumio://settings/'; true`).catch(() => {});
  await L.wait(600);
  assert.match(await L.main(() => global.lumio.tabs.wc().getURL()), /form\.html$/);
});

test('tabs: new, switch, close, reopen', async () => {
  await L.main(() => global.lumio.cmd.newTab());
  await L.main((_e, u) => global.lumio.tabs.navigate(u), siteUrl + '/');
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Lighthouses'));
  let s = await L.main(() => global.lumio.tabs.state());
  assert.equal(s.tabs.length, 2);
  await L.main(() => global.lumio.cmd.tabIndex(1));
  s = await L.main(() => global.lumio.tabs.state());
  assert.equal(s.activeId, s.tabs[0].id);
  await L.main(() => global.lumio.cmd.tabIndex(2));
  await L.main(() => global.lumio.cmd.closeTab());
  assert.equal((await L.main(() => global.lumio.tabs.state())).tabs.length, 1);
  await L.main(() => global.lumio.cmd.reopenTab());
  await L.wait(500);
  s = await L.main(() => global.lumio.tabs.state());
  assert.equal(s.tabs.length, 2);
  assert.match(s.tabs[1].url, /127\.0\.0\.1/);
});

test('find in page counts matches', async () => {
  await L.main(() => global.lumio.cmd.tabIndex(2));
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Lighthouses'));
  await L.main(() => global.lumio.cmd.find());
  await L.shell(`(() => { const i = document.getElementById('find-input'); i.value = 'keeper'; i.dispatchEvent(new Event('input')); return true })()`);
  const count = await until(() => L.shell(`document.getElementById('find-count').textContent`));
  assert.match(count, /\/3$/);
  await L.shell(`document.getElementById('find-close').click(); true`);
});

test('bookmarks and history are recorded', async () => {
  await L.main(() => global.lumio.cmd.bookmark());
  const marks = await L.main(() => global.lumio.store.bookmarks());
  assert.ok(marks.some((b) => b.title.includes('Lighthouses')));
  const hist = await L.main(() => global.lumio.store.history());
  assert.ok(hist.length >= 2);
});

test('signed out, the panel asks to sign in; on the Free plan the AI is ready', async () => {
  assert.ok(await until(() => L.shell(`document.querySelector('#messages .empty h2')?.textContent === 'Sign in to use Lumio AI'`)));
  assert.equal(await L.shell(`!!document.getElementById('lumio-sign-in') && !document.querySelector('#messages input')`), true, 'a sign-in button, no key field');
  const refused = await L.main(() => global.lumio.ai.send({ text: 'hi' }));
  assert.match(refused.error, /Sign in to Lumio/);
  // Signing in happens on the Lumio website, in a tab.
  const tabsBefore = await L.main(() => global.lumio.tabs.tabs.length);
  await L.shell(`document.getElementById('lumio-sign-in').click(); true`);
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === 'Sign in · Lumio');
  await L.page(`document.getElementById('continue').click(); true`);
  assert.ok(await until(() => L.main(() => global.lumio.account.state().signedIn), 15_000));
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === tabsBefore), 'the sign-in tab closes');
  assert.equal((await L.main(() => global.lumio.ai.state())).ready, true, 'Free is enough');
  assert.ok(await until(() => L.shell(`!!document.querySelector('.suggestion')`)));
});

test('one model; the thinking-effort slider under the chat box sets how hard it thinks', async () => {
  assert.equal(await L.shell(`!!document.querySelector('#composer .composer-row #reasoning-btn')`), true);
  assert.equal(await L.shell(`document.getElementById('reasoning-name').textContent`), 'Medium');
  assert.equal(await L.shell(`document.querySelectorAll('#reasoning-bars rect').length`), 3);
  await L.shell(`document.getElementById('reasoning-btn').click(); true`);
  assert.deepEqual(await L.shell(`[...document.querySelectorAll('#effort-ticks button')].map((b) => b.textContent)`), ['Low', 'Medium', 'High']);
  assert.equal(await L.shell(`document.getElementById('effort-slider').getAttribute('aria-valuenow')`), '1');
  assert.equal(await L.shell(`document.getElementById('effort-label').textContent`), 'Medium');
  // The server names the model (the browser doesn't hard-code it).
  assert.equal(await L.shell(`document.getElementById('effort-model').textContent`), 'Mock Agent');
  // It opens upward, above the chat box, and shows what's left of the plan.
  assert.equal(await L.shell(`document.getElementById('reasoning-menu').getBoundingClientRect().bottom <= document.getElementById('composer').getBoundingClientRect().top`), true);
  assert.match(await L.shell(`document.getElementById('reasoning-foot').textContent`), /Lumio Free · \d+% left\s*Get more/);
  await L.wait(400);
  await shot('05-effort-slider');
  // A real click at the right end of the track moves the knob to High.
  const r = await L.shell(`(() => { const b = document.getElementById('effort-slider').getBoundingClientRect(); return { x: Math.round(b.right - 6), y: Math.round(b.top + b.height / 2) }; })()`);
  await L.main(async (_e, p) => {
    const wc = global.lumio.win.webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }, r);
  await until(async () => (await L.shell(`document.getElementById('reasoning-name').textContent`)) === 'High');
  assert.equal(await L.main(() => global.lumio.store.settings.reasoning), 'high');
  assert.equal(await L.shell(`document.getElementById('effort-slider').getAttribute('aria-valuenow')`), '2');
  // Arrow keys step through the levels; the tick labels pick one directly.
  await L.shell(`document.getElementById('effort-slider').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); true`);
  await until(async () => (await L.main(() => global.lumio.store.settings.reasoning)) === 'medium');
  await L.shell(`document.querySelector('#effort-ticks [data-i="2"]').click(); true`);
  await until(async () => (await L.main(() => global.lumio.store.settings.reasoning)) === 'high');
  // Escape closes it.
  await L.shell(`document.getElementById('effort-slider').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  assert.equal(await L.shell(`document.getElementById('reasoning-menu').hidden`), true);
  assert.equal(await L.shell(`document.getElementById('reasoning-name').textContent`), 'High');
  // Anything else is refused.
  await L.main(() => global.lumio.ai.setReasoning('extreme'));
  assert.equal(await L.main(() => global.lumio.store.settings.reasoning), 'high');
});

test('chat streams markdown and includes the page when asked', async () => {
  await ask('summarize this page');
  await idle();
  assert.match(await lastReply(), /Keepers ran them/);
  const req = lumio.state.agentRequests.at(-1);
  assert.ok(req.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => /<current_page/.test(p.text || ''))));
  assert.equal(req.model, 'mock/agent-1', 'the model the server listed');
  assert.equal(req.reasoning, 'high', 'the chosen reasoning level');
  assert.ok(req.tools.includes('read_page'));
  await L.main(() => global.lumio.ai.setReasoning('medium'));
  await shot('02-chat');
});

test('agent fills a form with approvals and refuses password fields', async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), siteUrl + '/form.html');
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Pizza'));
  await L.shell(`document.getElementById('newchat-btn').click(); true`);
  await ask('Order a large pizza with extra cheese for Sam Tester, sam@example.com');
  let approvals = 0;
  for (let i = 0; i < 120 && (await L.main(() => global.lumio.ai.isRunning())); i++) {
    if (await L.shell(`!!document.querySelector('.approval [data-d="once"]:not(:disabled)')`)) {
      approvals++;
      if (approvals === 2) await shot('03-approval');
      await L.shell(`document.querySelector('.approval [data-d="once"]:not(:disabled)').click(); true`);
    }
    await L.wait(250);
  }
  assert.ok(approvals >= 6, `expected approvals, got ${approvals}`);
  const result = await L.page(`document.getElementById('result').textContent`);
  assert.match(result, /Order placed for Sam Tester \(sam@example\.com\): size l \+ extra cheese\. Trusted click: yes/);
  assert.equal(await L.page(`document.getElementById('pw').value`), '');
  const blocked = await L.shell(`document.querySelectorAll('.step.blocked').length`);
  assert.equal(blocked, 2);
  assert.match(await lastReply(), /Order placed for Sam Tester/);
  await shot('04-agent-done');
});

test('deny stops that action; Auto mode skips browser approvals', async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), siteUrl + '/form.html');
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Pizza'));
  await L.main(() => global.lumio.ai.setMode('auto'));
  await L.shell(`document.getElementById('newchat-btn').click(); true`);
  await ask('Order a pizza for Sam Tester, sam@example.com');
  await idle();
  assert.equal(await L.shell(`document.querySelectorAll('.approval').length`), 0);
  assert.match(await L.page(`document.getElementById('result').textContent`), /Order placed/);
  await L.main(() => global.lumio.ai.setMode('ask'));
  await ask('run a shell test');
  const card = await until(() => L.shell(`!!document.querySelector('.approval [data-d="deny"]')`));
  assert.ok(card);
  assert.match(await L.shell(`document.querySelector('.approval pre').textContent`), /echo lumio/);
  await L.shell(`document.querySelector('.approval [data-d="deny"]').click(); true`);
  await idle();
  assert.equal(await L.shell(`[...document.querySelectorAll('.step')].at(-1).className`), 'step denied');
});

test('shell commands run after approval', async () => {
  await ask('run a shell test');
  await until(() => L.shell(`!!document.querySelector('.approval [data-d="once"]')`));
  await L.shell(`document.querySelector('.approval [data-d="once"]').click(); true`);
  await idle();
  assert.match(await lastReply(), /lumio-42/);
});

test('screenshots of a tab reach the model as images', async () => {
  await ask('take a screenshot');
  await idle();
  assert.match(await lastReply(), /Images received: 1/);
  assert.ok(await L.shell(`!!document.querySelector('.step-thumb')`));
});

test('Stop ends a run and keeps the chat usable', async () => {
  await ask('Order a pizza for Sam Tester, sam@example.com');
  await until(() => L.shell(`!!document.querySelector('.approval [data-d="once"]:not(:disabled)')`));
  await L.shell(`document.getElementById('send').click(); true`); // the send button is Stop while running
  await idle();
  assert.match(await L.shell(`[...document.querySelectorAll('.notice')].at(-1).textContent`), /Stopped/);
  await ask('hello');
  await idle();
  assert.match(await lastReply(), /mock/);
});

test('multi-step tasks show a Task progress checklist', async () => {
  await L.main(() => global.lumio.ai.setMode('auto'));
  await ask('plan a trip to Lisbon');
  assert.ok(await until(() => L.shell(`!document.getElementById('plan').hidden && document.querySelectorAll('.plan-step').length === 3`)));
  assert.ok(await until(() => L.shell(`document.getElementById('plan-count').textContent === '1/3'`)), 'first step done');
  assert.equal(await L.shell(`document.querySelector('.plan-step.in_progress .t').textContent`), 'Compare hotels');
  await shot('30-task-progress');
  assert.equal(await L.shell(`document.querySelectorAll('.step').length > 0 && ![...document.querySelectorAll('.step')].some((e) => /plan/i.test(e.textContent))`), true, 'no chip for update_plan');
  await idle();
  assert.equal(await L.shell(`document.getElementById('plan-count').textContent`), '3/3');
  assert.ok(await until(() => L.shell(`document.getElementById('plan').classList.contains('collapsed')`), 4000), 'folds away when done');
  assert.ok(lumio.state.agentRequests.at(-1).tools.includes('update_plan'));
  // The plan is saved with the chat.
  const saved = await L.main(() => { const c = global.lumio.ai.chatStore.list()[0]; return global.lumio.ai.getChat(c.id).plan; });
  assert.deepEqual(saved.map((x) => x.status), ['done', 'done', 'done']);
  await L.main(() => global.lumio.ai.setMode('ask'));
});

test('while Lumio works on a page it glows, and the Stop bar stops it', async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), siteUrl + '/');
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes('Lighthouse'));
  await ask('please work on this page');
  const glowing = `[...document.documentElement.querySelectorAll('body > div')].some((d) => d.getAttribute('aria-hidden') === 'true' && d.style.zIndex === '2147483646')`;
  assert.ok(await until(() => L.page(glowing)), 'the page glows');
  assert.ok(await until(() => L.main(() => { const w = global.lumio.current; return !!w.indicator.bar && w.win.contentView.children.includes(w.indicator.bar); })), 'Stop bar shown');
  const geo = await L.main(() => { const w = global.lumio.current; return { bar: w.indicator.bar.getBounds(), slot: w.tabs.slot }; });
  assert.ok(geo.bar.y + geo.bar.height <= geo.slot.y + geo.slot.height && geo.bar.y > geo.slot.y + geo.slot.height / 2, 'bottom of the page area');
  assert.ok(Math.abs(geo.bar.x + geo.bar.width / 2 - (geo.slot.x + geo.slot.width / 2)) < 2, 'centered');
  await until(() => L.main(() => global.lumio.current.indicator.bar.webContents.executeJavaScript(`document.getElementById('step').textContent.length > 0`)));
  await L.wait(600);
  await shot('31-page-glow');
  await L.main(() => global.lumio.current.indicator.bar.webContents.executeJavaScript(`document.getElementById('stop').click(); true`));
  await idle();
  assert.match(await L.shell(`[...document.querySelectorAll('.notice')].at(-1).textContent`), /Stopped/);
  assert.equal(await L.page(glowing), false, 'glow removed');
  assert.equal(await L.main(() => { const w = global.lumio.current; return w.win.contentView.children.includes(w.indicator.bar); }), false, 'bar removed');
});

test('while Lumio controls the computer the screen glows, and the Stop pill stops it', async () => {
  await L.main(() => global.lumio.ai.setMode('bypass'));
  await ask('please use my computer');
  const auras = () => L.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('lumio://aura/')).map((w) => ({ url: w.webContents.getURL(), focusable: w.isFocusable(), top: w.isAlwaysOnTop(), visible: w.isVisible(), protected: w.isContentProtected?.() ?? null })));
  assert.ok(await until(async () => (await auras()).filter((a) => a.visible).length >= 2), 'glow and pill shown');
  const list = await auras();
  const displays = await L.main(({ screen }) => screen.getAllDisplays().length);
  assert.equal(list.filter((a) => a.url.includes('mode=glow')).length, displays, 'one glow per display');
  assert.equal(list.filter((a) => a.url.includes('mode=pill')).length, 1);
  assert.ok(list.every((a) => a.focusable === false && a.top), 'never takes focus, always on top');
  assert.ok(list.every((a) => a.protected !== false), 'left out of screen captures');
  assert.ok((await L.main(() => global.lumio.screenAura.windowIds())).length >= 2, 'ids passed to the helper');
  await L.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('mode=pill')).webContents.executeJavaScript(`document.getElementById('stop').click(); true`));
  await idle();
  assert.match(await L.shell(`[...document.querySelectorAll('.notice')].at(-1).textContent`), /Stopped/);
  assert.ok(await until(async () => (await auras()).length === 0, 3000), 'glow windows closed');
  assert.equal(await L.main(() => global.lumio.screenAura.active()), false);
  await L.main(() => global.lumio.ai.setMode('ask'));
});

test('out of allowance, the chat offers an upgrade', async () => {
  await ask('you are out of allowance');
  await idle();
  const note = await L.shell(`(() => { const n = [...document.querySelectorAll('.notice')].at(-1); return { text: n.textContent, button: n.querySelector('button')?.textContent } })()`);
  assert.match(note.text, /allowance/);
  assert.equal(note.button, 'Upgrade');
  const before = await L.main(() => global.lumio.tabs.tabs.length);
  await L.shell(`[...document.querySelectorAll('.notice')].at(-1).querySelector('button').click(); true`);
  await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === before + 1);
  assert.equal(await L.main(() => global.lumio.tabs.active.url), `${lumio.base}/account#plans`);
  await L.main(() => global.lumio.cmd.closeTab());
});

test('chats are saved without screenshots', async () => {
  const chats = await L.main(() => global.lumio.ai.listChats());
  assert.ok(chats.length >= 3);
  await L.main(() => global.lumio.store.chatsFile.flush());
  const raw = fs.readFileSync(path.join(L.userData, 'chats.json'), 'utf8');
  assert.ok(!raw.includes('data:image/jpeg'));
  const secrets = fs.readFileSync(path.join(L.userData, 'secrets.json'), 'utf8');
  assert.ok(!secrets.includes('sk-or-test-e2e'), 'key is encrypted at rest');
});
