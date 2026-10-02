import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runAgent, prepareMessages, repairHistory } = require('../main/ai/agent.js');
const { needsApproval } = require('../main/ai/policy.js');

// A fake model: returns scripted turns in order.
function fakeChat(turns) {
  let i = 0;
  const seen = [];
  const chat = async function* ({ messages }) {
    seen.push(messages);
    const t = turns[Math.min(i++, turns.length - 1)];
    if (t.text) yield { type: 'text', text: t.text };
    return { content: t.text || '', toolCalls: t.calls || [], finishReason: t.calls ? 'tool_calls' : 'stop' };
  };
  chat.seen = seen;
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

test('step cap stops runaway loops', async () => {
  const { opts, events } = setup({ turns: [{ calls: [{ id: 'r', name: 'read_page', arguments: '{}' }] }] });
  opts.maxSteps = 4;
  const res = await runAgent(opts);
  assert.equal(res.steps, 4);
  assert.equal(events.at(-1).reason, 'max_steps');
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
  const shot = tool('screenshot_tab', 'read', () => ({ text: 'shot', image: 'data:image/jpeg;base64,AAAA' }));
  const turns = Array.from({ length: 7 }, (_, i) => ({ calls: [{ id: String(i + 1), name: 'screenshot_tab', arguments: '{}' }] }));
  const { opts, chat } = setup({ turns: [...turns, { text: 'seen' }], tools: [shot] });
  await runAgent(opts);
  const images = (req) => req.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length;
  // Requests 2-6 see 1-5 screenshots; at 6 the oldest 4 go (2 left), then 3 at the 7th.
  assert.deepEqual(chat.seen.map(images), [0, 1, 2, 3, 4, 5, 2, 3]);
  assert.equal(chat.seen.at(-1)[0].role, 'system');
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
