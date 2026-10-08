import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runAgent, prepareMessages, repairHistory, MAX_STEPS, UNATTENDED_STEPS } = require('../main/ai/agent.js');
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
    return { content: t.text || '', toolCalls: t.calls || [], finishReason: t.calls ? 'tool_calls' : 'stop' };
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
    tool('run_shell', 'shell', () => { ran.push('run_shell'); return 'ok'; }),
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
  assert.equal(needsApproval('mac', 'auto'), true);
  assert.equal(needsApproval('shell', 'auto'), true);
  assert.equal(needsApproval('shell', 'bypass'), false);
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
    turns: [{ calls: [{ id: 'x', name: 'run_shell', arguments: '{}' }] }, { text: 'OK, I will not.' }],
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

test('stuck: waiting on purpose gets 4 times the room (12 checks with no change before the note, 24 before it ends)', async () => {
  const tools = [tool('wait', 'read', () => 'Done waiting.'), tool('read_page', 'read', () => 'Exporting your video…')];
  const { opts, messages, chat } = setup({ tools, turns: (i) => ({ calls: [{ id: `w${i}`, name: i % 2 ? 'read_page' : 'wait', arguments: i % 2 ? '{}' : '{"seconds":5}' }] }) });
  const res = await runAgent(opts);
  const results = messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const first = results.findIndex((r) => /Lumio Browser/.test(r));
  assert.equal(first, 23, 'no note before the 12th look');
  assert.match(results[first], /You have checked 12 times and nothing has changed\. Keep waiting only if it is still likely to finish/);
  assert.deepEqual(res, { steps: 48, reason: 'stuck', what: 'read_page' });
  assert.equal(chat.seen.length, 48);
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
