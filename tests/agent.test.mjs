import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
require.cache[electronPath] ??= { id: electronPath, filename: electronPath, loaded: true, exports: {} };
const { runAgent, prepareMessages, repairHistory, abortError, MAX_STEPS, UNATTENDED_STEPS } = require('../main/ai/agent.js');
const { needsApproval } = require('../main/ai/policy.js');

// A fake model: returns scripted turns in order (or turn(i) for the i-th, from 0).
function fakeChat(turns) {
  let i = 0;
  const seen = [];
  const quick = [];
  const chat = async function* ({ messages, quick: q }) {
    seen.push(messages);
    quick.push(!!q);
    const t = typeof turns === 'function' ? turns(i++) : turns[Math.min(i++, turns.length - 1)];
    if (t.text) yield { type: 'text', text: t.text };
    return { content: t.text || '', toolCalls: t.calls || [], finishReason: t.finishReason || (t.calls ? 'tool_calls' : 'stop') };
  };
  chat.seen = seen;
  chat.quick = quick;
  return chat;
}

const tool = (name, risk, run) => ({ name, risk, icon: 'app', description: name, parameters: { type: 'object', properties: {} }, label: () => name, run });

function setup({ turns, mode = 'ask', decide = () => 'once', tools }) {
  const events = [];
  const ran = [];
  const t = tools || [
    tool('read_page', 'read', () => { ran.push('read_page'); return 'page text'; }),
    tool('click', 'browser', () => { ran.push('click'); return 'clicked'; }),
    tool('navigate', 'browser', () => { ran.push('navigate'); return 'opened'; }),
  ];
  const messages = [{ role: 'user', content: 'go' }];
  const chat = fakeChat(turns);
  const opts = {
    model: 'm', messages, tools: t, systemPrompt: () => 'sys', chat,
    approve: async (id) => decide(id), getMode: () => mode, emit: (e) => events.push(e), ctx: {},
  };
  return { opts, events, ran, messages, chat };
}

test('policy', () => {
  assert.equal(needsApproval('read', 'ask'), false);
  assert.equal(needsApproval('browser', 'ask'), true);
  assert.equal(needsApproval('browser', 'auto'), false);
  assert.equal(needsApproval('browser', 'bypass'), false);
  assert.equal(needsApproval('read', 'bypass'), false);
  assert.equal(needsApproval('browser', 'unknown'), true, 'an unknown mode asks');
});

test('Lumio AI works only in the browser: no tools for the computer itself', () => {
  const COMPUTER = /^computer_|^(open_app|list_apps|run_shell|run_applescript)$/;
  const tools = ['browser', 'web', 'plan', 'make', 'schedule', 'helpers', 'workflow', 'tips'].flatMap((f) => require(`../main/ai/tools/${f}.js`).tools);
  assert.ok(tools.length > 20);
  assert.deepEqual(tools.filter((t) => COMPUTER.test(t.name)).map((t) => t.name), []);
  assert.deepEqual([...new Set(tools.map((t) => (typeof t.risk === 'function' ? 'browser' : t.risk)))].sort(), ['browser', 'read'], 'only looking and acting in tabs');
  assert.throws(() => require('../main/ai/tools/mac.js'), /Cannot find module/);
});

test('runs tools, asks for approval, and finishes with text', async () => {
  const { opts, events, ran, messages } = setup({
    turns: [
      { calls: [{ id: 'a', name: 'read_page', arguments: '{}' }] },
      { calls: [{ id: 'b', name: 'click', arguments: '{"ref":1}' }] },
      { text: 'All done.' },
    ],
  });
  await runAgent(opts);
  assert.deepEqual(ran, ['read_page', 'click']);
  assert.equal(events.filter((e) => e.type === 'approval').length, 1, 'only click asks');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(messages.at(-1).content, 'All done.');
  assert.equal(messages.filter((m) => m.role === 'tool').length, 2);
});

test('deny is reported to the model and the tool does not run', async () => {
  const { opts, ran, messages } = setup({
    turns: [{ calls: [{ id: 'x', name: 'navigate', arguments: '{}' }] }, { text: 'OK, I will not.' }],
    decide: () => 'deny',
  });
  await runAgent(opts);
  assert.deepEqual(ran, []);
  assert.match(messages.find((m) => m.role === 'tool').content, /denied/);
});

test('"allow for this task" skips later prompts for that tool', async () => {
  let asked = 0;
  const { opts, ran } = setup({
    turns: [
      { calls: [{ id: '1', name: 'click', arguments: '{}' }] },
      { calls: [{ id: '2', name: 'click', arguments: '{}' }] },
      { text: 'done' },
    ],
    decide: () => { asked++; return 'task'; },
  });
  await runAgent(opts);
  assert.equal(asked, 1);
  assert.deepEqual(ran, ['click', 'click']);
});

test('stop during approval aborts and history can be repaired', async () => {
  const ac = new AbortController();
  const { opts, messages } = setup({
    turns: [{ calls: [{ id: 's1', name: 'click', arguments: '{}' }, { id: 's2', name: 'read_page', arguments: '{}' }] }],
    decide: () => { ac.abort(); return 'stop'; },
  });
  opts.signal = ac.signal;
  await assert.rejects(runAgent(opts), (e) => e.name === 'AbortError');
  repairHistory(messages);
  const ids = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(ids, ['s1', 's2']);
});

test('a safety ceiling ends a runaway task (it says how many steps, so the chat can offer "continue")', async () => {
  const { opts, events } = setup({ turns: (i) => ({ calls: [{ id: `r${i}`, name: 'read_page', arguments: `{"tab_id":${i + 1}}` }] }) });
  opts.maxSteps = 4;
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 4, reason: 'max_steps' });
  assert.equal(events.at(-1).reason, 'max_steps');
  assert.equal(events.at(-1).steps, 4);
  // Ceilings ordinary tasks never reach: 1000 when the person is watching, 300 on its own.
  assert.equal(MAX_STEPS, 1000);
  assert.equal(UNATTENDED_STEPS, 300);
});

// Each turn reads something new, so it's never the same step twice.
const pages = (n, done = 'All done.') => (i) => (i < n ? { calls: [{ id: `p${i}`, name: 'read_page', arguments: `{"tab_id":${i + 1}}` }] } : { text: done });
const notes = (messages, re) => messages.filter((m) => m.role === 'tool' && re.test(m.content)).length;

test('no step budget: a task goes well past 100 steps and ends when the model is done', async () => {
  let n = 0;
  const { opts, events, messages, chat } = setup({ turns: pages(250, 'Read all 250 pages.'), tools: [tool('read_page', 'read', () => `page ${++n}`)] });
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 251, reason: 'complete' });
  assert.equal(chat.seen.length, 251);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).reason, 'complete');
  assert.equal(messages.at(-1).content, 'Read all 250 pages.');
  assert.equal(notes(messages, /Lumio Browser, not the user/), 0, 'nothing about repeating itself');
});

test('stuck: the same step with the same result gets a note at 3, and the task ends at 6', async () => {
  const shop = tool('click', 'read', () => 'Clicked [5]. Page is now: "Cart" — https://shop.test/cart');
  const { opts, events, messages, chat } = setup({ tools: [shop], turns: (i) => ({ calls: [{ id: `k${i}`, name: 'click', arguments: i % 2 ? '{"ref":5}' : '{ "ref": 5 }' }] }) });
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 6, reason: 'stuck', what: 'click' });
  assert.equal(chat.seen.length, 6);
  const results = messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.doesNotMatch(results[1], /same step/);
  assert.match(results[2], /You have now done this same step 3 times with the same result, so it is not working\. Try a different approach, or stop and tell the user what is blocking you\./);
  assert.match(results[4], /same step 5 times/);
  assert.match(results[5], /Lumio stopped the task here because you kept repeating the same step\. If the user says to continue, try a different approach\./);
  assert.deepEqual(chat.quick.slice(3), [false, false, false], 'after a note it thinks at full effort');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.reason, 'stuck');
  assert.equal(done.what, 'click');
});

test('stuck: the same step after something new came back (another "Load more") is not a repeat', async () => {
  let shown = 10;
  const tools = [tool('click', 'read', () => 'Clicked [7].'), tool('read_page', 'read', () => `Items 1-${(shown += 10)}`)];
  const { opts, messages } = setup({ tools, turns: (i) => (i < 40 ? { calls: [{ id: `l${i}`, name: i % 2 ? 'read_page' : 'click', arguments: i % 2 ? '{}' : '{"ref":7}' }] } : { text: 'Loaded them all.' }) });
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 41, reason: 'complete' });
  assert.equal(notes(messages, /same step|nothing has changed/), 0);
});

const toolResults = (messages) => messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('stuck: waiting on purpose is counted in time, not checks: a note every 2 minutes with no change, the end after 15', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let left = 3600;
  const tools = [
    tool('wait', 'read', () => { t.mock.timers.tick(5000); return 'Done waiting.'; }),
    // A countdown that ticks on its own is not a change.
    tool('read_page', 'read', () => { left -= 5; return `Exporting your video… about ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`; }),
  ];
  const { opts, messages, events } = setup({ tools, turns: (i) => ({ calls: [{ id: `w${i}`, name: i % 2 ? 'read_page' : 'wait', arguments: i % 2 ? '{}' : `{"seconds":${5 + (i % 3)}}` }] }) });
  const res = await runAgent(opts);
  // 5 s a check: 15 minutes with no change is 180 more waits after the first look.
  assert.deepEqual(res, { steps: 361, reason: 'stuck', what: 'wait', waited: 15 });
  const results = toolResults(messages);
  const notes = results.filter((r) => /You have checked/.test(r));
  assert.equal(notes.length, 7, 'at 2, 4, … 14 minutes');
  assert.match(notes[0], /You have checked \d+ times over 2 minutes and nothing has changed\. If you are waiting for something, use wait between checks, and keep waiting only if it is still likely to finish/);
  assert.match(results.at(-1), /Lumio stopped the task here because nothing changed for 15 minutes\./);
  assert.equal(events.at(-1).waited, 15);
});

test('stuck: a long wait that ends (a 10-minute export) is waited out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let ready = false;
  const tools = [
    tool('wait', 'read', () => { t.mock.timers.tick(10_000); return 'Done waiting.'; }),
    tool('read_page', 'read', () => { ready = Date.now() >= 10 * 60_000; return ready ? 'Your video is ready. Download' : 'Exporting your video…'; }),
  ];
  const { opts, messages } = setup({ tools, turns: (i) => (ready ? { text: 'Your video is ready.' } : { calls: [{ id: `w${i}`, name: i % 2 ? 'read_page' : 'wait', arguments: i % 2 ? '{}' : '{"seconds":10}' }] }) });
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 121, reason: 'complete' });
  assert.equal(toolResults(messages).filter((r) => /You have checked/.test(r)).length, 4, 'a note at 2, 4, 6 and 8 minutes');
});

test('stuck: looking again and again without wait is waiting too: it is told to use wait, and not ended after a few looks', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let n = 0;
  const tools = [tool('read_page', 'read', () => { t.mock.timers.tick(3000); return ++n < 60 ? 'Processing your payment…' : 'Payment received.'; })];
  const { opts, messages } = setup({ tools, turns: (i) => (n >= 60 ? { text: 'It went through.' } : { calls: [{ id: `r${i}`, name: 'read_page', arguments: '{}' }] }) });
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 61, reason: 'complete' });
  const results = toolResults(messages);
  assert.match(results[2], /You have checked 3 times and nothing has changed\. If you are waiting for something, use wait between checks/);
  assert.equal(results.filter((r) => /You have checked/.test(r)).length, 2, 'then only every 2 minutes');
});

test('stuck: a loop of 3 different steps (retrying a wrong code) gets a note and is ended', async () => {
  const page = '"Verify" — https://bank.test/verify';
  const tools = [
    tool('read_page', 'read', () => `Tab 1: ${page}\nInvalid code. Try again.`),
    tool('type', 'read', () => `Typed into [3]. Page is now: ${page}`),
    tool('click', 'read', () => `Clicked [5]. Page is now: ${page}`),
  ];
  const cycle = [['read_page', '{}'], ['type', '{"ref":3,"text":"1234"}'], ['click', '{"ref":5}']];
  const { opts, messages, events } = setup({ tools, turns: (i) => ({ calls: [{ id: `v${i}`, name: cycle[i % 3][0], arguments: cycle[i % 3][1] }] }) });
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 15, reason: 'stuck', what: 'click' }, '12 steps in a row with nothing new after the first round');
  const results = toolResults(messages);
  assert.equal(results.findIndex((r) => /Lumio Browser/.test(r)), 8, 'the 3rd round');
  assert.match(results[8], /You have now done this same step 3 times with the same result/);
  assert.match(results[14], /Lumio stopped the task here because you kept repeating the same step/);
  assert.equal(events.at(-1).reason, 'stuck');
});

test('stuck: a loop of 4 different steps gets a note after 8 steps that repeat earlier ones, and ends after 12', async () => {
  const page = '"Verify" — https://bank.test/verify';
  const tools = [
    tool('navigate', 'read', () => `Page is now: ${page}`),
    tool('read_page', 'read', () => `Tab 1: ${page}\nInvalid code. Try again.`),
    tool('type', 'read', () => `Typed into [3]. Page is now: ${page}`),
    tool('click', 'read', () => `Clicked [5]. Page is now: ${page}`),
  ];
  const cycle = [['navigate', '{"url":"https://bank.test/verify"}'], ['read_page', '{}'], ['type', '{"ref":3,"text":"1234"}'], ['click', '{"ref":5}']];
  const { opts, messages } = setup({ tools, turns: (i) => ({ calls: [{ id: `v${i}`, name: cycle[i % 4][0], arguments: cycle[i % 4][1] }] }) });
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 16, reason: 'stuck', what: 'click' });
  const results = toolResults(messages);
  assert.equal(results.findIndex((r) => /Lumio Browser/.test(r)), 11);
  assert.match(results[11], /Your last 8 steps repeated earlier ones with the same results, so this is not working\./);
});

test('stuck: text that changes on its own (times, "seconds ago") and new screenshot bytes are not progress', async () => {
  let k = 0;
  const map = '"Map" — https://maps.test/';
  const clock = tool('read_page', 'read', () => { k++; return `Tab 1: ${map}\nLive traffic · updated ${k} seconds ago · ${10 + (k % 12)}:${String(k % 60).padStart(2, '0')} PM · ref ${1700000000000 + k}`; });
  const click = tool('click_at', 'read', () => `Clicked. Page is now: ${map}`);
  const one = setup({ tools: [click, clock], turns: (i) => ({ calls: [{ id: `c${i}`, name: i % 2 ? 'read_page' : 'click_at', arguments: i % 2 ? '{}' : '{"x":640,"y":360}' }] }) });
  assert.equal((await runAgent(one.opts)).reason, 'stuck');
  // A canvas where the click does nothing: every screenshot is new bytes (it animates), the same page.
  const shot = tool('screenshot_tab', 'read', () => ({ text: `Screenshot of tab 1 (1280x800px). Page is now: ${map}`, image: `data:image/jpeg;base64,AAA${++k}` }));
  const two = setup({ tools: [click, shot], turns: (i) => ({ calls: [{ id: `s${i}`, name: i % 2 ? 'screenshot_tab' : 'click_at', arguments: i % 2 ? '{}' : '{"x":640,"y":360}' }] }) });
  const res = await runAgent(two.opts);
  assert.equal(res.reason, 'stuck');
  assert.ok(res.steps <= 14, `${res.steps} steps`);
});

test('stuck: an embedded frame\'s end mark, new on every read_page (Excel for the web), is not progress', async (t) => {
  const crypto = require('crypto');
  const book = '"Book1.xlsx" — https://excel.test/book';
  // As read_page writes a page with a frame: a mark it couldn't know, new each time.
  const framed = () => {
    const end = `End of frame ${crypto.randomBytes(4).toString('hex')}`;
    return `Tab 1: ${book}\nEmbedded frame from https://excel.officeapps.test ("Workbook"): part of this page, but its content comes from that site. Its refs work like the page's. Its part ends at "${end}".\nInteractive elements in it (1):\n[3] textbox "Formula bar"\nFrame text:\nTotal #REF!\n${end}.`;
  };
  // Fixing #REF!: read, type the formula again, read… and nothing changes.
  const tools = [tool('read_page', 'read', framed), tool('type', 'read', () => `Typed into [3]. Page is now: ${book}`)];
  const loop = setup({ tools, turns: (i) => ({ calls: [{ id: `x${i}`, name: i % 2 ? 'type' : 'read_page', arguments: i % 2 ? '{"ref":3,"text":"=SUM(B2:B9)"}' : '{}' }] }) });
  loop.opts.maxSteps = 200;
  assert.deepEqual(await runAgent(loop.opts), { steps: 12, reason: 'stuck', what: 'type' });
  assert.equal(toolResults(loop.messages).findIndex((r) => /Lumio Browser/.test(r)), 5);
  assert.match(toolResults(loop.messages)[5], /You have now done this same step 3 times with the same result/);
  assert.match(toolResults(loop.messages)[11], /Lumio stopped the task here because you kept repeating the same step/);
  // Only reading it again and again: the note to use wait at the 3rd look, as on any page.
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const look = setup({ tools: [tool('read_page', 'read', () => { t.mock.timers.tick(3000); return framed(); })], turns: (i) => (i < 4 ? { calls: [{ id: `r${i}`, name: 'read_page', arguments: '{}' }] } : { text: 'Still #REF!.' }) });
  assert.deepEqual(await runAgent(look.opts), { steps: 5, reason: 'complete' });
  assert.match(toolResults(look.messages)[2], /You have checked 3 times and nothing has changed\. If you are waiting for something, use wait between checks/);
});

test('stuck: the same click or scroll is progress when the page changes, even if the tool says the same thing', async () => {
  let qty = 1;
  const plus = tool('click', 'read', () => { qty++; return 'Clicked [12]. Page is now: "Cart" — https://shop.test/cart'; });
  const a = setup({ tools: [plus], turns: (i) => (qty < 8 ? { calls: [{ id: `q${i}`, name: 'click', arguments: '{"ref":12}' }] } : { text: 'The quantity is 8.' }) });
  a.opts.ctx = { pageState: () => `quantity ${qty}` };
  assert.deepEqual(await runAgent(a.opts), { steps: 8, reason: 'complete' });
  assert.equal(toolResults(a.messages).filter((r) => /Lumio Browser/.test(r)).length, 0);
  // A mail list that scrolls inside the page: the window stays at 0.
  let top = 0;
  const scroll = tool('scroll', 'read', () => { top += 700; return 'Scrolled down. Now at 0 of 900px (viewport 900px).'; });
  const b = setup({ tools: [scroll], turns: (i) => (i < 12 ? { calls: [{ id: `s${i}`, name: 'scroll', arguments: '{"direction":"down"}' }] } : { text: 'Found the March email.' }) });
  b.opts.ctx = { pageState: (volatile) => { assert.equal(typeof volatile, 'string'); return `list at ${top}`; } };
  assert.deepEqual(await runAgent(b.opts), { steps: 13, reason: 'complete' });
  assert.equal(toolResults(b.messages).filter((r) => /Lumio Browser/.test(r)).length, 0);
});

test('near a safety ceiling the model is told to wrap up, and its answer ends the task normally', async () => {
  let seen = null;
  const { opts, chat } = setup({
    turns: (i) => (/only 3 more steps/.test(seen?.at(-1)?.content || '') ? { text: 'Read 7 pages; 3 are left.' } : { calls: [{ id: `p${i}`, name: 'read_page', arguments: `{"tab_id":${i + 1}}` }] }),
  });
  const inner = opts.chat;
  opts.chat = (o) => { seen = o.messages; return inner(o); };
  opts.maxSteps = 10;
  assert.deepEqual(await runAgent(opts), { steps: 8, reason: 'complete' });
  assert.match(chat.seen[7].at(-1).content, /This task can take only 3 more steps\. Finish up now: reply with what you did and found, and what is still left to do\./);
});

test('stuck: a message from the person while it repeats itself starts the count again', async () => {
  const queue = [];
  const { opts, chat } = setup({
    tools: [tool('click', 'read', () => { if (chat.seen.length === 5) queue.push('try the other button'); return 'Clicked [5].'; })],
    turns: (i) => ({ calls: [{ id: `m${i}`, name: 'click', arguments: '{"ref":5}' }] }),
  });
  opts.takeQueued = () => queue.splice(0);
  const res = await runAgent(opts);
  assert.equal(res.reason, 'stuck');
  assert.equal(res.steps, 11, 'six more of the same after the message');
});

test('Stop still ends a long task', async () => {
  const ac = new AbortController();
  let n = 0;
  const { opts, events, chat } = setup({ turns: pages(500), tools: [tool('read_page', 'read', () => { if (++n === 150) ac.abort(); return `page ${n}`; })] });
  opts.signal = ac.signal;
  await assert.rejects(runAgent(opts), (e) => e.name === 'AbortError');
  assert.equal(chat.seen.length, 150);
  assert.equal(events.filter((e) => e.type === 'done').length, 0);
});

test('more than 12 tool calls in one turn: the first 12 run and the model is told (the server takes 12)', async () => {
  const calls = Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, name: 'read_page', arguments: `{"tab_id":${i + 1}}` }));
  const { opts, messages, ran } = setup({ turns: [{ calls }, { text: 'Read them.' }] });
  await runAgent(opts);
  assert.equal(messages[1].tool_calls.length, 12);
  assert.equal(ran.length, 12);
  const results = messages.filter((m) => m.role === 'tool');
  assert.equal(results.length, 12);
  assert.match(results.at(-1).content, /Only your first 12 tool calls ran; the other 2 did not\. Call them again if you still need them\./);
});

test('bad JSON arguments and unknown tools become errors, not crashes', async () => {
  const { opts, messages } = setup({
    turns: [{ calls: [{ id: 'j', name: 'click', arguments: '{nope' }, { id: 'u', name: 'rm_rf', arguments: '{}' }] }, { text: 'sorry' }],
    mode: 'bypass',
  });
  await runAgent(opts);
  const tools = messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /not valid JSON/);
  assert.match(tools[1], /no tool named/);
});

test('screenshots are sent as images; older ones are dropped 4 at a time so each request starts with the previous one', async () => {
  let k = 0;
  const shot = tool('screenshot_tab', 'read', () => ({ text: 'shot', image: `data:image/jpeg;base64,AAA${++k}` }));
  const turns = Array.from({ length: 7 }, (_, i) => ({ calls: [{ id: String(i + 1), name: 'screenshot_tab', arguments: '{}' }] }));
  const { opts, chat, messages } = setup({ turns: [...turns, { text: 'seen' }], tools: [shot] });
  await runAgent(opts);
  const images = (req) => req.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length;
  // Requests 2-6 see 1-5 screenshots; at 6 the oldest 4 go (2 left), then 3 at the 7th.
  assert.deepEqual(chat.seen.map(images), [0, 1, 2, 3, 4, 5, 2, 3]);
  assert.equal(chat.seen.at(-1)[0].role, 'system');
  // The ones it won't send again aren't kept in memory either.
  assert.equal(images(messages), 3);
  // Except right after a batch is dropped, each request starts with the whole previous one.
  for (let i = 1; i < chat.seen.length; i++) {
    if (i === 6) continue;
    assert.deepEqual(chat.seen[i].slice(0, chat.seen[i - 1].length), chat.seen[i - 1], `request ${i + 1}`);
  }
});

test('prepareMessages keeps plain messages untouched', () => {
  const out = prepareMessages('sys', [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(out, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
});

test('messages sent while Lumio works join before its next step, even after its answer', async () => {
  const queue = [];
  const { opts, messages, chat } = setup({
    mode: 'auto',
    turns: [
      { calls: [{ id: 'a', name: 'read_page', arguments: '{}' }] },
      { text: 'Here are the Amazon prices.' },
      { text: 'Okay, Best Buy instead: $379.' },
    ],
    tools: [{ name: 'read_page', risk: 'read', icon: 'app', description: 'r', parameters: { type: 'object', properties: {} }, label: () => 'Reading', run: () => { queue.push('actually use Best Buy'); return 'page'; } }],
  });
  let lateSent = false;
  opts.takeQueued = () => {
    // Something said while the final answer streams is answered too.
    if (!queue.length && chat.seen.length === 2 && !lateSent) { lateSent = true; return ['and the cheapest one?']; }
    return queue.splice(0);
  };
  await runAgent(opts);
  const roles = messages.map((m) => `${m.role}${typeof m.content === 'string' && m.role === 'user' ? `:${m.content}` : ''}`);
  assert.deepEqual(roles, ['user:go', 'assistant', 'tool', 'user:actually use Best Buy', 'assistant', 'user:and the cheapest one?', 'assistant']);
  assert.equal(chat.seen.length, 3);
});

test('speed: the first turn plans at full effort; routine turns are quick; errors, research and new messages think fully', async () => {
  const tools = [
    tool('read_page', 'read', () => 'page text'),
    tool('click', 'read', () => 'clicked'),
    tool('type', 'read', () => { throw new Error('field gone'); }),
    tool('web_search', 'read', () => 'results'),
  ];
  const { opts, chat, events } = setup({
    tools,
    turns: [
      { calls: [{ id: 'a', name: 'read_page', arguments: '{}' }] },
      { calls: [{ id: 'b', name: 'click', arguments: '{}' }] },
      { calls: [{ id: 'c', name: 'type', arguments: '{}' }] },
      { calls: [{ id: 'd', name: 'web_search', arguments: '{}' }] },
      { calls: [{ id: 'e', name: 'click', arguments: '{}' }] },
      { text: 'Done.' },
    ],
  });
  await runAgent(opts);
  //               plan   after read  after click  after error  after search  after click
  assert.deepEqual(chat.quick, [false, true, true, false, false, true]);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.timing.steps, 6);
  assert.ok(done.timing.ms >= done.timing.modelMs + done.timing.toolMs - 5);
});

test('site tips: given before the first step and when a new site comes up, once each', async () => {
  const shown = ['[Lumio Browser, not the user] Tips for docs.google.com: paste rows', '[Lumio Browser, not the user] Tips for mail.google.com: compose'];
  const { opts, chat, messages } = setup({
    turns: [{ calls: [{ id: 'a', name: 'read_page', arguments: '{}' }] }, { calls: [{ id: 'b', name: 'read_page', arguments: '{}' }] }, { text: 'Done.' }],
  });
  opts.ctx = { siteTips: () => shown.shift() ?? null };
  await runAgent(opts);
  assert.equal(messages[1].content, '[Lumio Browser, not the user] Tips for docs.google.com: paste rows', 'before the first step');
  assert.match(chat.seen[1].at(-1).content, /page text\n\n\[Lumio Browser, not the user\] Tips for mail\.google\.com/, 'with the result that reached the new site');
  assert.doesNotMatch(chat.seen[2].at(-1).content, /Tips for/);
});

test('speed: a voice message answers quickly from the first turn', async () => {
  const { opts, chat } = setup({ turns: [{ calls: [{ id: 'a', name: 'read_page', arguments: '{}' }] }, { text: 'Here it is.' }] });
  opts.quickStart = true;
  await runAgent(opts);
  assert.deepEqual(chat.quick, [true, true]);
});

// ---------------------------------------------------------------- keep going
// The model answers without tools while its own checklist (update_plan) still
// has steps to do: Lumio tells it to carry on instead of ending the task.
const { tools: planTools } = require('../main/ai/tools/plan.js');
const updatePlan = planTools.find((t) => t.name === 'update_plan');
const planCall = (id, steps) => ({ calls: [{ id, name: 'update_plan', arguments: JSON.stringify({ steps: steps.map(([title, status, reason]) => ({ title, status, ...(reason ? { reason } : {}) })) }) }] });
const BAKERY = [['Ingredients sheet', 'done'], ['Weekly formulas', 'in_progress'], ['Supplier orders', 'pending'], ['Costs', 'pending']];
const REPORT = { text: 'The weekly formulas currently show #REF! because those sheets haven’t been set up correctly yet. I wasn’t able to finish the supplier-order and costs sheets.' };
const kept = (events) => events.filter((e) => e.type === 'continued');
const keepNotes = (messages) => messages.filter((m) => m.role === 'user' && /Your task checklist isn't finished/.test(m.content));
function planSetup(turns, { tools = [], ...rest } = {}) {
  let n = 0;
  const plans = [];
  const s = setup({
    turns,
    tools: [updatePlan, tool('read_page', 'read', (args) => `page ${args?.tab_id ?? ''}`), tool('click', 'read', () => `Clicked. Fixed ${++n}.`), ...tools],
    ...rest,
  });
  s.opts.ctx = { setPlan: (p) => plans.push(p) };
  return { ...s, plans };
}

test('keep going: it stops with a progress report while its checklist has steps left, is told to carry on, and finishes them', async () => {
  const { opts, events, messages, chat, plans } = planSetup([
    planCall('p1', BAKERY),
    REPORT,
    { calls: [{ id: 'fix', name: 'click', arguments: '{"ref":4}' }] },
    planCall('p2', BAKERY.map(([title]) => [title, 'done'])),
    { text: 'All done: the workbook has every sheet, and the formulas work.' },
  ]);
  const res = await runAgent(opts);
  assert.deepEqual(res, { steps: 5, reason: 'complete' });
  assert.deepEqual(kept(events).map(({ left, steps }) => ({ left, steps })), [{ left: 3, steps: ['Weekly formulas', 'Supplier orders', 'Costs'] }]);
  // Its report stays in the chat; the note follows it as a message from Lumio Browser.
  const at = messages.findIndex((m) => m.role === 'assistant' && m.content === REPORT.text);
  assert.equal(messages[at + 1].role, 'user');
  assert.equal(messages[at + 1].content, `[Lumio Browser, not the user] Your task checklist isn't finished. Still to do: "Weekly formulas", "Supplier orders", "Costs". Keep working: fix what's broken (like #REF! errors) and finish the remaining steps; a progress report is not a stopping point. If some of those steps are already done, mark them done with update_plan. Only stop if you truly need the user (a sign-in, an OK to pay or buy, a decision only they can make, information you can't find): then ask exactly that, and mark that step blocked in update_plan with the reason.`);
  assert.equal(chat.seen[2].at(-1), messages[at + 1], 'the next request ends with it');
  assert.equal(chat.quick[2], false, 'it thinks at full effort after being told');
  assert.deepEqual(events.filter((e) => e.type === 'done').map((e) => e.reason), ['complete'], 'one ending, at the real end');
  assert.equal(plans.at(-1).every((s) => s.status === 'done'), true);
  assert.equal(messages.at(-1).content, 'All done: the workbook has every sheet, and the formulas work.');
});

test('keep going: a step marked blocked (it needs the person) ends the turn, with the reason on the checklist', async () => {
  const { opts, events, plans, chat } = planSetup([
    planCall('p1', [['Fill the cart', 'done'], ['Check out', 'blocked', 'Needs your OK to pay $42.10 on DoorDash'], ['Confirm the order', 'pending']]),
    { text: 'Your cart is ready ($42.10). Should I place the order?' },
  ]);
  assert.deepEqual(await runAgent(opts), { steps: 2, reason: 'complete' });
  assert.equal(chat.seen.length, 2);
  assert.deepEqual(kept(events), []);
  assert.deepEqual(plans[0][1], { title: 'Check out', status: 'blocked', reason: 'Needs your OK to pay $42.10 on DoorDash' });
});

test('keep going: not after Stop', async () => {
  // Stop pressed while it was answering: the answer ends the run.
  const ac = new AbortController();
  const one = planSetup((i) => (i === 0 ? planCall('p1', BAKERY) : (ac.abort(), REPORT)));
  one.opts.signal = ac.signal;
  assert.deepEqual(await runAgent(one.opts), { steps: 2, reason: 'complete' });
  assert.equal(one.chat.seen.length, 2);
  assert.deepEqual(kept(one.events), []);
  assert.deepEqual(keepNotes(one.messages), []);
  // Stop pressed while the model works on the answer (the request is cancelled).
  const two = planSetup([planCall('p1', BAKERY), REPORT]);
  const ac2 = new AbortController();
  const inner = two.opts.chat;
  two.opts.chat = (o) => { if (two.chat.seen.length === 1) { ac2.abort(); throw abortError(); } return inner(o); };
  two.opts.signal = ac2.signal;
  await assert.rejects(runAgent(two.opts), (e) => e.name === 'AbortError');
  assert.deepEqual(kept(two.events), []);
});

test('keep going: at most 3 times in a row without progress, then the task ends as usual', async () => {
  const { opts, events, messages, chat } = planSetup((i) => (i === 0 ? planCall('p1', BAKERY) : { text: `I'll stop here (${i}).` }));
  assert.deepEqual(await runAgent(opts), { steps: 5, reason: 'complete' });
  assert.equal(chat.seen.length, 5);
  assert.equal(kept(events).length, 3);
  assert.equal(keepNotes(messages).length, 3);
  assert.equal(messages.at(-1).content, "I'll stop here (4).");
  assert.equal(events.at(-1).type, 'done');
});

test('keep going: progress starts the count again: new work or a plan step done, not a repeat or a rewritten plan', async () => {
  const PLAN = [['A', 'in_progress'], ['B', 'pending'], ['C', 'pending']];
  const read = (id) => ({ calls: [{ id, name: 'read_page', arguments: '{"tab_id":1}' }] });
  const stop = { text: 'Stopping.' };
  // New work resets it; a read, or the plan rewritten with nothing done, doesn't.
  const click = (id) => ({ calls: [{ id, name: 'click', arguments: '{"ref":1}' }] });
  const a = planSetup([planCall('p1', PLAN), stop, click('r1'), stop, read('r2'), stop, planCall('p2', [['A (fix #REF!)', 'in_progress'], ['B', 'pending'], ['C', 'pending']]), stop, stop]);
  assert.deepEqual(await runAgent(a.opts), { steps: 9, reason: 'complete' });
  assert.equal(kept(a.events).length, 4, 'once before the new work, then 3 more');
  // A plan step done resets it.
  const b = planSetup([planCall('p1', PLAN), stop, stop, planCall('p2', [['A', 'done'], ['B', 'in_progress'], ['C', 'pending']]), stop, stop, stop, stop]);
  assert.deepEqual(await runAgent(b.opts), { steps: 8, reason: 'complete' });
  assert.deepEqual(kept(b.events).map((e) => e.left), [3, 3, 2, 2, 2]);
});

test('keep going: no checklist, or every step done: its answer ends the task as before', async () => {
  const none = planSetup([{ calls: [{ id: 'a', name: 'read_page', arguments: '{}' }] }, { text: 'Here is the page.' }]);
  assert.deepEqual(await runAgent(none.opts), { steps: 2, reason: 'complete' });
  assert.deepEqual(kept(none.events), []);
  const finished = planSetup([planCall('p1', BAKERY.map(([title]) => [title, 'done'])), { text: 'Done.' }]);
  assert.deepEqual(await runAgent(finished.opts), { steps: 2, reason: 'complete' });
  assert.deepEqual(kept(finished.events), []);
});

test('keep going: not when its answer is for the person: an action they denied, a field left for them, a message they sent', async () => {
  // Denied: it explains or asks what they want instead.
  const denied = planSetup([planCall('p1', BAKERY), { calls: [{ id: 'buy', name: 'navigate', arguments: '{}' }] }, { text: 'OK, I won’t open it. What should I do instead?' }], {
    tools: [tool('navigate', 'browser', () => 'opened')],
    decide: () => 'deny',
  });
  assert.deepEqual(await runAgent(denied.opts), { steps: 3, reason: 'complete' });
  assert.deepEqual(kept(denied.events), []);
  // A password or card field it refused to fill: the person fills it in.
  const field = planSetup([planCall('p1', BAKERY), { calls: [{ id: 'pw', name: 'type', arguments: '{"ref":3}' }] }, { text: 'Please type your password, then tell me to continue.' }], {
    tools: [tool('type', 'read', () => ({ text: 'Refused: this looks like a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' }))],
  });
  assert.deepEqual(await runAgent(field.opts), { steps: 3, reason: 'complete' });
  assert.deepEqual(kept(field.events), []);
  // They asked something while it worked: the answer is for them.
  const queue = ['what does the costs sheet show so far?'];
  const asked = planSetup([planCall('p1', BAKERY), { calls: [{ id: 'r', name: 'read_page', arguments: '{}' }] }, { text: 'So far: flour $3.20/kg, sugar $1.10/kg.' }]);
  let n = 0;
  asked.opts.takeQueued = () => (++n === 2 ? queue.splice(0) : []);
  assert.deepEqual(await runAgent(asked.opts), { steps: 3, reason: 'complete' });
  assert.deepEqual(kept(asked.events), []);
  // But after more work of its own, an answer with steps left is pushed on again.
  const later = planSetup([planCall('p1', BAKERY), { calls: [{ id: 'buy', name: 'navigate', arguments: '{}' }] }, { calls: [{ id: 'c', name: 'click', arguments: '{"ref":9}' }] }, REPORT, planCall('p2', BAKERY.map(([title]) => [title, 'done'])), { text: 'Done.' }], {
    tools: [tool('navigate', 'browser', () => 'opened')],
    decide: () => 'deny',
  });
  await runAgent(later.opts);
  assert.equal(kept(later.events).length, 1);
});

test('keep going: a field left for the person stays theirs while it only looks (a screenshot, read_page, the plan) before asking', async () => {
  const card = tool('type', 'read', () => ({ text: 'Refused: this is a payment field (card number). Ask the user to fill it in themselves.', summary: 'Payment field, left for you', status: 'blocked' }));
  const shot = tool('screenshot_tab', 'read', () => ({ text: 'Screenshot of tab 1 (1280x800px). Page is now: "Checkout" — https://pay.test/', image: 'data:image/jpeg;base64,AAA' }));
  const PAY = [['Fill the cart', 'done'], ['Pay', 'in_progress'], ['Confirm the order', 'pending']];
  const ask = { text: 'Please enter your card details yourself, then tell me to continue.' };
  const typeCard = { calls: [{ id: 'card', name: 'type', arguments: '{"ref":3,"text":"4242"}' }] };
  for (const looks of [['screenshot_tab'], ['read_page'], ['screenshot_tab', 'read_page'], ['update_plan']]) {
    const turns = [planCall('p1', PAY), typeCard, ...looks.map((name, i) => (name === 'update_plan' ? planCall(`p${i + 2}`, PAY) : { calls: [{ id: `l${i}`, name, arguments: '{}' }] })), ask];
    const s = planSetup(turns, { tools: [card, shot] });
    assert.deepEqual(await runAgent(s.opts), { steps: turns.length, reason: 'complete' }, looks.join(', '));
    assert.deepEqual(kept(s.events), [], looks.join(', '));
  }
  // The same for an action they denied.
  const denied = planSetup([planCall('p1', PAY), { calls: [{ id: 'buy', name: 'navigate', arguments: '{}' }] }, { calls: [{ id: 's', name: 'screenshot_tab', arguments: '{}' }] }, { text: 'OK, I won’t pay. Tell me when you want to.' }], {
    tools: [tool('navigate', 'browser', () => 'opened'), shot],
    decide: () => 'deny',
  });
  assert.deepEqual(await runAgent(denied.opts), { steps: 4, reason: 'complete' });
  assert.deepEqual(kept(denied.events), []);
  // Refused, then a refused field and new work in the same turn: still theirs.
  const both = planSetup([planCall('p1', PAY), { calls: [{ id: 'c', name: 'click', arguments: '{"ref":8}' }, { id: 'card', name: 'type', arguments: '{"ref":3}' }] }, ask], { tools: [card] });
  assert.deepEqual(await runAgent(both.opts), { steps: 3, reason: 'complete' });
  assert.deepEqual(kept(both.events), []);
  // New work of its own after the refusal: an answer with steps left is pushed on again.
  const moved = planSetup([planCall('p1', PAY), typeCard, { calls: [{ id: 's', name: 'screenshot_tab', arguments: '{}' }] }, { calls: [{ id: 'c', name: 'click', arguments: '{"ref":9}' }] }, REPORT, planCall('p2', PAY.map(([title]) => [title, 'done'])), { text: 'Done.' }], { tools: [card, shot] });
  await runAgent(moved.opts);
  assert.equal(kept(moved.events).length, 1);
});

test('keep going: not once it was told to wrap up near the safety ceiling', async () => {
  const { opts, events, chat } = planSetup((i) => (i === 0 ? planCall('p1', BAKERY) : /only 3 more steps/.test(chat.seen.at(-1).at(-1).content) ? REPORT : { calls: [{ id: `r${i}`, name: 'read_page', arguments: `{"tab_id":${i}}` }] }));
  opts.maxSteps = 10;
  assert.deepEqual(await runAgent(opts), { steps: 8, reason: 'complete' });
  assert.deepEqual(kept(events), []);
});

test('keep going: only looking (read_page, screenshots) between answers is not progress', async () => {
  const read = (i) => ({ calls: [{ id: `r${i}`, name: 'read_page', arguments: `{"tab_id":${i}}` }] }); // a page that changes a little each time
  const { opts, events } = planSetup((i) => (i === 0 ? planCall('p1', BAKERY) : i % 2 ? { text: 'Stuck.' } : read(i)));
  await runAgent(opts);
  assert.equal(kept(events).length, 3);
});

test('keep going: steps added to the checklist already done are not progress', async () => {
  const { opts, events } = planSetup((i) => (i === 0 ? planCall('p1', BAKERY) : i % 2 ? { text: 'Stuck.' } : planCall(`p${i}`, [...BAKERY, ...Array.from({ length: i }, (_, k) => [`Reviewed ${k}`, 'done'])])));
  await runAgent(opts);
  assert.equal(kept(events).length, 3);
});

test('keep going: not when the answer was cut off (length), nor for a question after a note', async () => {
  const cut = planSetup([planCall('p1', BAKERY), { text: 'The weekly formulas', finishReason: 'length' }]);
  assert.deepEqual(await runAgent(cut.opts), { steps: 2, reason: 'length' });
  assert.deepEqual(kept(cut.events), []);
  const asks = planSetup([planCall('p1', BAKERY), REPORT, { text: 'Google wants you to sign in. Can you sign in, then tell me to continue?' }]);
  assert.deepEqual(await runAgent(asks.opts), { steps: 3, reason: 'complete' });
  assert.equal(kept(asks.events).length, 1);
});
