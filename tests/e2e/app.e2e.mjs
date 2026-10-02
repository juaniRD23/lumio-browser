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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { startMockLumio } from '../mock-lumio.mjs';
import { turnEvents } from '../mock-scripts.mjs';

const FIX = path.join(root, 'tests', 'fixtures');
const SHOTS = process.env.LUMIO_SHOTS;
let L;
let site;
let siteUrl;
let lumio;
const DOWNLOADS = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'lumio-dl-'));

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
  L = await launch({ env: { LUMIO_ACCOUNT_BASE: lumio.base, LUMIO_AI_BASE: lumio.base, LUMIO_DOWNLOADS: DOWNLOADS } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(800);
});

after(async () => {
  await L?.close();
  site?.close();
  lumio?.server.close();
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
});

test('opens on the Lumio new tab page with the AI panel', async () => {
  const url = await L.main(() => global.lumio.tabs.wc().getURL());
  assert.equal(url, 'lumio://newtab/');
  assert.match(await L.page('document.body.innerText'), /Lumio/);
  assert.equal(await L.shell(`document.body.classList.contains('panel-closed')`), false);
  await shot('01-newtab');
});

test('the AI panel slides open and closed, and the page follows it frame by frame', async () => {
  // Samples the page view's width while the panel animates. GitHub's Mac
  // runners draw fewer frames, so they need fewer distinct widths.
  const steps = process.env.CI ? 3 : 6;
  const slide = (button) => L.main(async (_e, btn) => {
    const w = global.lumio.current;
    const widths = new Set();
    const t0 = Date.now();
    w.win.webContents.executeJavaScript(`document.getElementById('${btn}').click()`);
    while (Date.now() - t0 < 700) { widths.add(w.tabs.active.view.getBounds().width); await new Promise((r) => setTimeout(r, 12)); }
    return [...widths];
  }, button);
  try {
    const closing = await slide('panel-close');
    assert.ok(closing.length >= steps, `page widened in steps while closing (${closing.join(', ')})`);
    assert.equal(await L.shell(`getComputedStyle(document.getElementById('panel')).visibility`), 'hidden');
    const opening = await slide('ai-toggle');
    assert.ok(opening.length >= steps, `page narrowed in steps while opening (${opening.join(', ')})`);
    assert.equal(await L.shell(`Math.round(document.getElementById('panel').getBoundingClientRect().width)`), 380);
  } finally {
    // The tests after this one use the panel: never leave it closed.
    if (await L.shell(`document.body.classList.contains('panel-closed')`)) {
      await L.shell(`document.getElementById('ai-toggle').click(); true`);
      await L.wait(600);
    }
  }
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

test('approvals: one button shows the mode, and its menu switches between Ask, Auto and Bypass', async () => {
  const start = await L.main(() => global.lumio.store.settings.approvalMode);
  const pick = async (m) => {
    await L.shell(`document.getElementById('mode-btn').click(); true`);
    assert.equal(await L.shell(`document.getElementById('mode-menu').hidden`), false);
    await L.shell(`document.querySelector('#mode-menu [data-mode="${m}"]').click(); true`);
    assert.ok(await until(() => L.main((_e, x) => global.lumio.store.settings.approvalMode === x, m)), `mode ${m}`);
    assert.equal(await L.shell(`document.getElementById('mode-menu').hidden`), true);
  };
  await pick('auto');
  assert.equal(await L.shell(`document.getElementById('mode-name').textContent`), 'Auto');
  await L.shell(`document.getElementById('mode-btn').click(); true`);
  assert.match(await L.shell(`document.getElementById('mode-menu').innerText`), /Ask[\s\S]*Auto[\s\S]*Bypass/);
  assert.equal(await L.shell(`document.querySelector('#mode-menu [data-mode="auto"]').getAttribute('aria-checked')`), 'true');
  await shot('03-approvals-menu');
  await L.shell(`document.getElementById('mode-btn').click(); true`);
  await pick('bypass');
  assert.equal(await L.shell(`document.getElementById('mode-btn').classList.contains('bypass')`), true);
  await pick(start);
  assert.equal(await L.shell(`document.getElementById('mode-btn').classList.contains('bypass')`), false);
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
  // The deny test's card fades out with disabled buttons; only click a live one.
  await until(() => L.shell(`!!document.querySelector('.approval [data-d="once"]:not(:disabled)')`));
  await L.shell(`document.querySelector('.approval [data-d="once"]:not(:disabled)').click(); true`);
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

test('typing while Lumio works adds to the task, and "stop" stops it', async () => {
  const type = (text) => L.shell(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); return document.getElementById('send').title })()`);
  // A task that keeps waiting until it's told something.
  lumio.state.agentScript = (body) => {
    const last = body.messages.at(-1);
    if (last.role === 'user' && typeof last.content === 'string' && /while you were working/.test(last.content)) return turnEvents({ text: 'Okay, switching to Best Buy.' });
    return turnEvents({ calls: [{ name: 'wait', args: { seconds: 2 } }] });
  };
  try {
    await ask('compare headphone prices on Amazon');
    assert.equal(await type(''), 'Stop (Esc)', 'an empty box keeps Stop');
    assert.equal(await type('actually use Best Buy'), 'Add to the task (↵)');
    await L.shell(`document.getElementById('send').click(); true`);
    assert.ok(await until(() => L.shell(`[...document.querySelectorAll('.msg.user')].at(-1).innerText.includes('actually use Best Buy')`)));
    assert.equal(await L.main(() => global.lumio.ai.isRunning()), true, 'the task keeps going');
    await idle();
    assert.match(await lastReply(), /switching to Best Buy/);
    const msgs = lumio.state.agentRequests.at(-1).messages;
    assert.match(msgs.at(-1).content, /^actually use Best Buy\n\n\[Lumio Browser, not the user\] The user sent this while you were working/);
    assert.equal(msgs.at(-2).role, 'tool', 'it joined right after the step it was sent during');

    // "stop" ends the task instead of joining it.
    lumio.state.agentScript = () => turnEvents({ calls: [{ name: 'wait', args: { seconds: 5 } }] });
    await ask('another long task');
    await type('stop');
    await L.shell(`document.getElementById('send').click(); true`);
    assert.ok(await until(async () => !(await L.main(() => global.lumio.ai.isRunning())), 4000), 'stopped');
    assert.match(await L.shell(`[...document.querySelectorAll('.notice')].at(-1).textContent`), /Stopped/);
  } finally {
    lumio.state.agentScript = null;
  }
});

test('on High effort, Lumio sends helper AIs to work in background tabs, each with its colored dot', async () => {
  const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n'));
  lumio.state.agentScript = (body) => {
    const asked = textOf(body.messages[0]);
    const turns = body.messages.filter((m) => m.role === 'assistant').length;
    const helper = /You are Helper (\d)/.exec(asked);
    if (helper) {
      if (turns === 0) return turnEvents({ calls: [{ name: 'wait', args: { seconds: 2 } }] });
      if (turns === 1) return turnEvents({ calls: [{ name: 'read_page' }] });
      const title = /^Tab \d+: "([^"]*)"/m.exec(body.messages.at(-1).content)?.[1];
      return turnEvents({ text: `Helper ${helper[1]} read “${title}”.` });
    }
    if (turns === 0) {
      return turnEvents({ calls: [{ name: 'send_helpers', args: { helpers: [
        { title: 'First source', task: 'Read the article and report its title.', url: `${siteUrl}/` },
        { title: 'Second source', task: 'Read the article and report its title too.', url: `${siteUrl}/` },
      ] } }] });
    }
    const reports = textOf(body.messages.at(-1));
    return turnEvents({ text: /Helper 1 read “.+”[\s\S]*Helper 2 read “.+”/.test(reports) ? 'Both helpers reported back.' : 'A report is missing.' });
  };
  const tabsBefore = await L.main(() => global.lumio.tabs.tabs.length);
  const active = await L.main(() => global.lumio.tabs.activeId);
  await L.main(() => global.lumio.ai.setReasoning('high'));
  const before = lumio.state.agentRequests.length;
  await L.shell(`document.getElementById('newchat-btn').click(); true`); // the script counts this chat's turns
  try {
    await ask('research this two ways at once');
    // While they work: two new background tabs, each with its helper's colored dot.
    assert.ok(await until(() => L.main(() => global.lumio.tabs.tabs.filter((t) => t.agent).length === 2)), 'two helpers working');
    assert.deepEqual(await L.main(() => global.lumio.tabs.tabs.filter((t) => t.agent).map((t) => t.agent.color)), ['#86b7ff', '#b58cff']);
    assert.equal(await L.main(() => global.lumio.tabs.activeId), active, 'your tab stays in front');
    assert.ok(await until(() => L.shell(`document.querySelectorAll('.tab .agent-dot:not([hidden])').length === 2`)));
    assert.ok(await until(() => L.shell(`document.querySelectorAll('.helpers .helper.working').length === 2`)));
    await shot('49-helpers');
    await idle();
    assert.match(await lastReply(), /Both helpers reported back/);
    assert.equal(await L.main(() => global.lumio.tabs.tabs.length), tabsBefore, 'their tabs closed when done');
    assert.equal(await L.shell(`document.querySelectorAll('.helpers .helper:not(.working):not(.failed)').length`), 2);
    const reqs = lumio.state.agentRequests.slice(before);
    const main = reqs.filter((r) => !/You are Helper/.test(textOf(r.messages[0])));
    const helpers = reqs.filter((r) => /You are Helper/.test(textOf(r.messages[0])));
    assert.ok(main[0].tools.includes('send_helpers') && main[0].reasoning === 'high');
    assert.ok(helpers.length >= 6 && helpers.every((r) => r.reasoning === 'medium' && !r.tools.includes('send_helpers') && !r.tools.includes('run_shell')));
  } finally {
    lumio.state.agentScript = null;
    await L.main(() => global.lumio.ai.setReasoning('medium'));
  }
});

test('workflows: Lumio saves one, / runs it with its blank filled in, and Settings lists it', async () => {
  const mode = await L.main(() => global.lumio.store.settings.approvalMode);
  await L.main(() => global.lumio.ai.setMode('auto'));
  try {
    await ask('save this as a workflow');
    await idle();
    assert.match(await lastReply(), /Saved the workflow “Page summary”/);
    const [w] = await L.main(() => global.lumio.workflows.list());
    assert.deepEqual(w.inputs, [{ name: 'page', label: 'Which page' }]);

    // Type / to pick it; the card asks for the blank.
    await L.shell(`(() => { const p = document.getElementById('prompt'); p.focus(); p.value = '/page'; p.dispatchEvent(new Event('input')); return true })()`);
    assert.ok(await until(() => L.shell(`!document.getElementById('wf-menu').hidden && document.querySelectorAll('#wf-menu .menu-row').length === 1`)));
    await L.shell(`document.querySelector('#wf-menu .menu-row').click(); true`);
    assert.ok(await until(() => L.shell(`!document.getElementById('wf-card').hidden`)));
    await L.shell(`(() => { const i = document.querySelector('#wf-card input'); i.value = 'apnews.com'; document.querySelector('#wf-card .wf-run').click(); return true })()`);
    await until(() => L.main(() => global.lumio.ai.isRunning()), 3000);
    await idle();
    assert.match(await lastReply(), /summary of the page you picked/);
    const sent = lumio.state.agentRequests.at(-1).messages[0].content;
    assert.match(sent, /^Run my workflow “Page summary” \(Which page: apnews\.com\)/);
    assert.match(sent, /<workflow title="Page summary">\nOpen apnews\.com and summarize it in three bullet points\.\n<\/workflow>/);
    assert.equal((await L.main(() => global.lumio.workflows.list()))[0].runs, 1);

    await L.main((_e, u) => global.lumio.tabs.navigate(u), 'lumio://settings/#workflows');
    assert.ok(await until(() => L.page(`document.getElementById('wf-list')?.innerText.includes('Page summary')`)));
    assert.match(await L.page(`document.getElementById('wf-list').innerText`), /Asks for Which page · Run 1 time/);
    await shot('50-workflows');
    await L.page(`window.confirm = () => true; document.querySelector('#wf-list [data-act="delete"]').click(); true`);
    assert.ok(await until(() => L.main(() => global.lumio.workflows.list().length === 0)));
  } finally {
    await L.main((_e, m) => global.lumio.ai.setMode(m), mode);
  }
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

test('the + menu attaches pictures and files (Office files read by the server), and the model gets them', async () => {
  await L.shell(`document.getElementById('newchat-btn').click(); true`);
  await L.shell(`document.getElementById('plus-btn').click(); true`);
  assert.equal(await L.shell(`!document.getElementById('plus-menu').hidden`), true);
  await until(async () => (await L.shell(`document.querySelectorAll('#apps .app-row').length`)) === 5);
  assert.match(await L.shell(`document.getElementById('apps').innerText`), /Gmail[\s\S]*Connect/);
  await L.wait(300);
  await shot('40-plus-menu');
  await L.shell(`document.getElementById('plus-btn').click(); true`);
  await L.shell(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 200;
    const g = c.getContext('2d'); g.fillStyle = '#2f6fdd'; g.fillRect(0, 0, 320, 200);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'blue.png', { type: 'image/png' }));
    dt.items.add(new File(['Rent: 1200'], 'budget.txt', { type: 'text/plain' }));
    dt.items.add(new File([new Uint8Array([80, 75, 3, 4, 9, 9])], 'Plan.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await until(async () => (await L.shell(`document.querySelectorAll('#tray .att.ready').length`)) === 3, 10_000);
  await shot('41-attachments');
  await ask('What is in these files?');
  await idle();
  assert.match(await lastReply(), /1 picture\(s\) and these files: budget\.txt, Plan\.docx/);
  const sent = lumio.state.agentRequests.at(-1).messages.at(-1).content;
  assert.ok(sent.some((p) => p.type === 'text' && p.text.includes('Extracted Plan.docx (6 bytes)')), 'the Word file was read by the server');
  assert.ok(sent.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/')));
  assert.equal(await L.shell(`document.querySelectorAll('.msg.user .files .att').length`), 3);
  assert.equal(await L.shell(`document.getElementById('tray').hidden`), true);
});

test('Lumio makes a picture and a PDF: saved to Downloads and shown with Open', async () => {
  await ask('Draw a fox');
  await idle();
  assert.equal(lumio.state.lastImagePrompt, 'A red fox in snow');
  assert.equal(await L.shell(`!!document.querySelector('.made-img img')`), true);
  const pic = fs.readdirSync(DOWNLOADS).find((f) => f.endsWith('.png'));
  assert.ok(pic, 'picture saved to Downloads');
  assert.ok(await L.shell(`document.querySelector('.made-img img').complete && document.querySelector('.made-img img').naturalWidth === 2`), 'shown from lumio://shell/ai-files');
  await ask('Make a PDF of my trip');
  await idle();
  assert.match(await lastReply(), /Your PDF is ready/);
  const pdf = path.join(DOWNLOADS, 'Trip Plan.pdf');
  assert.ok(fs.existsSync(pdf), 'PDF saved to Downloads');
  assert.equal(fs.readFileSync(pdf).subarray(0, 4).toString(), '%PDF');
  assert.match(await L.shell(`document.querySelector('.doc-card').innerText`), /Trip Plan\.pdf[\s\S]*PDF document/);
  await ask('Make a deck of my trip');
  await idle();
  assert.equal(fs.readFileSync(path.join(DOWNLOADS, 'Trip Plan.pptx')).subarray(0, 2).toString(), 'PK');
  // The card only opens files Lumio made.
  assert.equal(await L.main((_e, p) => global.lumio.ai.ownsFile(p), pdf), true);
  assert.equal(await L.main(() => global.lumio.ai.ownsFile('/etc/hosts')), false);
  await shot('42-made-files');
});

test('connections: connect Gmail from the + menu, then Lumio searches it through the server', async () => {
  await L.shell(`document.getElementById('plus-btn').click(); true`);
  await until(async () => (await L.shell(`document.querySelectorAll('#apps [data-connect]').length`)) === 5);
  await L.shell(`document.querySelector('#apps [data-connect="gmail"]').click(); true`);
  await until(async () => lumio.state.connected.has('gmail'));
  await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())).includes('/account'));
  await L.main(() => global.lumio.tabs.close(global.lumio.tabs.activeId));
  await L.main(() => global.lumio.ai.refreshCapabilities());
  await until(async () => (await L.main(() => global.lumio.ai.tools().map((t) => t.name))).includes('gmail_search'));
  await ask('Anything in my email from my boss?');
  await idle();
  assert.match(await lastReply(), /From Gmail: Subject: Q3 numbers/);
  assert.deepEqual(lumio.state.toolRuns.at(-1), { name: 'gmail_search', arguments: { query: 'from:boss' } });
  // Turned off in the + menu: no Gmail tools.
  await L.shell(`document.getElementById('plus-btn').click(); true`);
  await until(async () => (await L.shell(`!!document.querySelector('#apps input[data-app="Gmail"]')`)));
  await L.shell(`(() => { const i = document.querySelector('#apps input[data-app="Gmail"]'); i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(async () => !(await L.main(() => global.lumio.ai.tools().map((t) => t.name))).includes('gmail_search'));
  await L.main(() => global.lumio.ai.setApp('Gmail', true));
  await L.shell(`document.getElementById('plus-btn').click(); true`);
});

test('the usage ring next to Send shows the plan, and opens the details', async () => {
  assert.equal(await L.shell(`document.getElementById('usage-btn').hidden`), false);
  const offset = await L.shell(`parseFloat(document.querySelector('#usage-btn .ring-fg').style.strokeDashoffset)`);
  assert.ok(Math.abs(offset - 2 * Math.PI * 8.5 * 0.62) < 0.5, `38% used (${offset})`);
  await L.shell(`document.getElementById('usage-btn').click(); true`);
  const text = await L.shell(`document.getElementById('usage-pop').innerText`);
  assert.match(text, /Lumio Free[\s\S]*Weekly usage[\s\S]*38% used[\s\S]*62% left[\s\S]*fully by[\s\S]*No 5-hour limits/i);
  await L.wait(300);
  await shot('43-usage');
  await L.shell(`document.getElementById('usage-btn').click(); true`);
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

test('ask about my tabs: the + menu sends every open tab with the message', async () => {
  await L.main((_e, u) => global.lumio.tabs.create(u), siteUrl + '/');
  await until(() => L.main(() => !global.lumio.tabs.active.loading && /^http/.test(global.lumio.tabs.active.url || '')));
  await L.shell(`document.getElementById('plus-btn').click(); true`);
  await L.shell(`document.getElementById('add-tabs').click(); true`);
  assert.equal(await L.shell(`document.querySelector('#context-chip span').textContent`), 'All open tabs');
  assert.equal(await L.shell(`document.getElementById('plus-menu').hidden`), true);
  await shot('47-all-tabs');
  const before = lumio.state.agentRequests.length;
  // A fixed answer: the scripted model matches words anywhere in the message,
  // and every open tab is in this one (the pizza form among them).
  lumio.state.agentScript = () => turnEvents({ text: 'The lighthouse article talks about keepers.' });
  try {
    await ask('which tab talks about keepers?');
    await idle();
  } finally {
    lumio.state.agentScript = null;
  }
  assert.match(await lastReply(), /lighthouse article/);
  const req = lumio.state.agentRequests.slice(before)[0];
  const sent = req.messages.at(-1).content.map((p) => p.text || '').join('\n');
  assert.match(sent, /<open_tabs count="\d+"/);
  assert.ok(sent.includes(`url="${siteUrl}/"`), 'the page tab is in it');
  assert.match(sent, /Keepers/i, 'with its text');
  assert.doesNotMatch(sent, /<current_page/, 'instead of just the current page');
  assert.match(await L.shell(`[...document.querySelectorAll('.msg.user .ctx')].at(-1).innerText`), /\d+ open tabs?/);
  assert.notEqual(await L.shell(`document.querySelector('#context-chip span').textContent`), 'All open tabs', 'one message only');
});

test('voice: an empty box offers voice mode where Send is, and voice calls reach the server', async () => {
  const setPrompt = (v) => L.shell(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(v)}; p.dispatchEvent(new Event('input')); return true })()`);
  await setPrompt('');
  assert.equal(await L.shell(`document.getElementById('send').hidden`), true);
  assert.equal(await L.shell(`document.getElementById('voice-btn').hidden`), false);
  assert.equal(await L.shell(`document.getElementById('mic-btn').hidden`), false);
  await setPrompt('hello');
  assert.equal(await L.shell(`document.getElementById('send').hidden`), false);
  assert.equal(await L.shell(`document.getElementById('voice-btn').hidden`), true);
  await setPrompt('');
  const heard = await L.main(() => global.lumio.ai.transcribe({ data: new Uint8Array(4000).fill(7), mime: 'audio/webm;codecs=opus', seconds: 3 }));
  assert.deepEqual(heard, { text: 'What is on this page?' });
  const spoken = await L.main(async () => { const r = await global.lumio.ai.speak({ text: 'Hello there.' }); return Buffer.from(r.audio).toString(); });
  assert.equal(spoken, 'ID3mockaudio');
  const [t, sp] = lumio.state.voice.slice(-2);
  assert.equal(t.body.format, 'webm');
  assert.equal(Buffer.from(t.body.audio, 'base64').length, 4000);
  assert.deepEqual(sp.body, { text: 'Hello there.' });
});

test('scheduled tasks: Lumio schedules one, Settings lists it, and Run now runs it', async () => {
  const mode = await L.main(() => global.lumio.store.settings.approvalMode);
  await L.main(() => global.lumio.ai.setMode('auto'));
  try {
    await ask('every morning at 8, give me the news');
    await idle();
    assert.match(await lastReply(), /Scheduled “Morning news”/);
    const [task] = await L.main(() => global.lumio.ai.schedules.list());
    assert.equal(task.when, 'Every day at 8:00 AM');
    assert.equal(task.prompt, 'Say good morning with three headlines');

    await L.main((_e, u) => global.lumio.tabs.navigate(u), 'lumio://settings/#scheduled');
    assert.ok(await until(() => L.page(`document.getElementById('sched-list')?.innerText.includes('Morning news')`)));
    assert.match(await L.page(`document.getElementById('sched-list').innerText`), /Every day at 8:00 AM · Next:/);
    await shot('48-scheduled');
    const runs = lumio.state.agentRequests.length;
    await L.page(`document.querySelector('[data-act="run"]').click(); true`);
    assert.ok(await until(() => L.main((_e, id) => global.lumio.ai.schedules.get(id)?.lastStatus === 'done', task.id), 20_000), 'the run finished');
    const sent = lumio.state.agentRequests[runs].messages.at(-1).content;
    assert.match(sent, /^Say good morning with three headlines/);
    assert.match(sent, /This is a scheduled task the user set up earlier/);
    assert.equal((await L.main((_e, id) => global.lumio.ai.schedules.get(id), task.id)).nextRun, task.nextRun, 'Run now keeps the schedule');
    assert.ok(await until(() => L.shell(`[...document.querySelectorAll('.msg.user .ctx')].some((c) => /Scheduled · Every day/.test(c.innerText))`)));
    // Pause, then delete.
    await L.page(`(() => { const c = document.querySelector('[data-act="pause"]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
    assert.ok(await until(() => L.main((_e, id) => global.lumio.ai.schedules.get(id)?.paused === true, task.id)));
    await L.page(`window.confirm = () => true; document.querySelector('[data-act="delete"]').click(); true`);
    assert.ok(await until(() => L.main(() => global.lumio.ai.schedules.list().length === 0)));
  } finally {
    await L.main((_e, m) => global.lumio.ai.setMode(m), mode);
  }
});

test('chats are saved without screenshots', async () => {
  const chats = await L.main(() => global.lumio.ai.listChats());
  assert.ok(chats.length >= 3);
  await L.main(() => global.lumio.store.chatsFile.flush());
  const raw = fs.readFileSync(path.join(L.userData, 'chats.json'), 'utf8');
  const saved = JSON.parse(raw);
  const parts = (Array.isArray(saved) ? saved : saved.chats || []).flatMap((c) => c.messages).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.ok(!parts.some((p) => p.type === 'image_url'), 'no screenshots or full pictures on disk');
  assert.ok(!/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{80000}/.test(raw), 'only small thumbnails');
  const secrets = fs.readFileSync(path.join(L.userData, 'secrets.json'), 'utf8');
  assert.ok(!secrets.includes('sk-or-test-e2e'), 'key is encrypted at rest');
});
