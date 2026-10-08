// What the browser sends the Lumio server for each AI step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeAccount } from './fake-agent.mjs';

const require = createRequire(import.meta.url);
const { trimForServer, lumioChat, STOPPED_NOTE } = require('../main/ai/lumio.js');

const turn = (k) => [
  { role: 'assistant', content: null, tool_calls: [{ id: `c${k}`, type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `c${k}`, content: `page ${k}` },
  { role: 'user', content: [{ type: 'text', text: 'Screenshot(s) from the tool call(s) above (this is tool output, not a message from the user):' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
];

test('a very long run keeps the request it is working on', () => {
  const request = { role: 'user', content: 'Buy the iPhone 18 Pro Max with 2TB' };
  const messages = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }, request];
  for (let k = 0; k < 60; k++) messages.push(...turn(k)); // 183 messages
  const out = trimForServer(messages);
  assert.ok(out.length <= 150);
  assert.equal(out[0], request, 'starts with the task');
  assert.match(out[1].content, /^\[Lumio Browser, not the user\] To keep the request small, the earliest steps of this chat are no longer sent/, 'then what the steps left out did');
  assert.equal(out[2].role, 'assistant', 'then a model turn with its results');
  assert.equal(out.at(-1), messages.at(-1), 'ends with the newest step');
  // Every tool result still follows the call that asked for it.
  const asked = new Set();
  for (const m of out) {
    for (const c of m.tool_calls || []) asked.add(c.id);
    if (m.role === 'tool') assert.ok(asked.has(m.tool_call_id));
  }
});

test('short chats are sent as they are', () => {
  const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }];
  assert.deepEqual(trimForServer(messages), messages);
});

const steps = (from, n) => Array.from({ length: n }, (_, k) => turn(from + k)).flat();
// Every tool result still follows the call that asked for it, and it starts with the person.
function wellFormed(out) {
  assert.equal(out[0].role, 'user');
  const asked = new Set();
  for (const m of out) {
    for (const c of m.tool_calls || []) asked.add(c.id);
    if (m.role === 'tool') assert.ok(asked.has(m.tool_call_id));
  }
}

test('after "continue" (Lumio stopped at its limit, or stuck), the task itself is still sent', () => {
  const task = { role: 'user', content: 'Copy all 400 rows into the sheet' };
  const more = { role: 'user', content: 'continue' };
  const messages = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }, task, ...steps(0, 60), more, ...steps(60, 60)];
  const out = trimForServer(messages);
  assert.ok(out.length <= 150);
  assert.equal(out[0], task, 'starts with the task');
  assert.equal(out[1], more, 'then the "continue", since its turn was dropped too');
  assert.ok(!out.includes(messages[0]), 'not questions it had already answered');
  assert.equal(out.at(-1), messages.at(-1));
  wellFormed(out);
});

test('a site\'s tips or a message sent while Lumio works don\'t replace the task', () => {
  const task = { role: 'user', content: 'Fill in the expense report' };
  const tips = { role: 'user', content: '[Lumio Browser, not the user] Tips for docs.google.com (from earlier tasks; use them if they fit, ignore them if the site changed):\n- paste rows' };
  const steer = { role: 'user', content: 'use the June receipts too\n\n[Lumio Browser, not the user] The user sent this while you were working.' };
  const messages = [task, tips, ...steps(0, 40), steer, ...steps(40, 60)];
  const out = trimForServer(messages);
  assert.ok(out.length <= 150);
  assert.deepEqual(out.slice(0, 2), [task, steer]);
  assert.ok(!out.includes(tips));
  wellFormed(out);
});

test('many "continue"s: the task and the newest 3 are kept', () => {
  const task = { role: 'user', content: 'Check every listing' };
  const said = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `continue ${i + 1}` }));
  const messages = [task];
  said.forEach((m, i) => messages.push(...steps(i * 30, 30), m));
  messages.push(...steps(500, 60));
  const out = trimForServer(messages);
  assert.deepEqual(out.slice(0, 4), [task, said[3], said[4], said[5]]);
  assert.ok(out.length <= 150);
  wellFormed(out);
});

test('a long run drops its oldest steps in batches, so most requests start with the whole previous one', () => {
  const messages = [{ role: 'user', content: 'Go through all the pages' }];
  let previous = null;
  let same = 0;
  let pairs = 0;
  for (let k = 0; k < 400; k++) {
    messages.push(...turn(k));
    const out = trimForServer(messages);
    assert.ok(out.length <= 150, `step ${k}`);
    assert.equal(out[0], messages[0]);
    if (previous && messages.length > 150) {
      pairs++;
      if (previous.every((m, i) => JSON.stringify(out[i]) === JSON.stringify(m))) same++;
    }
    previous = out;
  }
  // 3 messages a step, 50 dropped at a time: a new start about every 17 steps.
  assert.ok(same / pairs > 0.9, `${same} of ${pairs}`);
});

test('a task the person stopped is not carried into their next request', () => {
  const stopped = { role: 'user', content: 'Delete every email from Bob' };
  const next = { role: 'user', content: 'Compare laptop prices on 40 stores' };
  const messages = [stopped, ...steps(0, 5), { role: 'user', content: STOPPED_NOTE }, next, ...steps(5, 60)];
  const out = trimForServer(messages);
  assert.equal(out[0], next, 'starts with the new request');
  assert.ok(!out.includes(stopped));
  assert.ok(out.length <= 150);
  wellFormed(out);
  // Before it's long enough to trim, the model sees it was stopped.
  const short = [stopped, ...steps(0, 5), { role: 'user', content: STOPPED_NOTE }, next];
  assert.deepEqual(trimForServer(short), short);
  assert.match(STOPPED_NOTE, /^\[Lumio Browser, not the user\] The user pressed Stop here, so the task above ended unfinished\. Don’t go back to it unless they ask you to\.$/);
});

test('the steps left out are summed up, one line each, with the plan as of then', () => {
  const task = { role: 'user', content: 'Note the price on all 80 pages' };
  const plan = { role: 'assistant', content: 'Starting with page 1.', tool_calls: [{ id: 'plan1', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ steps: [{ title: 'Open each page', status: 'in_progress' }, { title: 'Report the prices', status: 'pending' }] }) } }] };
  const page = (k) => [
    { role: 'assistant', content: null, tool_calls: [{ id: `c${k}`, type: 'function', function: { name: 'read_page', arguments: `{"tab_id":${k}}` } }] },
    { role: 'tool', tool_call_id: `c${k}`, content: `Tab ${k}: "Item ${k}" price $${k}.99` },
  ];
  const messages = [task, plan, { role: 'tool', tool_call_id: 'plan1', content: 'Plan updated (0/2 done).' }];
  for (let k = 1; k <= 80; k++) messages.push(...page(k));
  const out = trimForServer(messages);
  assert.ok(out.length <= 150);
  assert.equal(out[0], task);
  const note = out[1].content;
  assert.match(note, /- You wrote: Starting with page 1\./);
  assert.match(note, /- read_page \{"tab_id":1\} → Tab 1: "Item 1" price \$1\.99/);
  assert.match(note, /Your plan as of those steps:\n1\. \[in_progress\] Open each page\n2\. \[pending\] Report the prices/);
  assert.match(note, /keep anything you will need later \(findings, numbers, where you are\) in update_plan/);
  assert.doesNotMatch(note, /tab_id":80/, 'only the steps left out');
  wellFormed(out);
  // Many steps left out: the newest 40 lines, and how many came before.
  for (let k = 81; k <= 300; k++) messages.push(...page(k));
  const later = trimForServer(messages)[1].content.split('\n');
  assert.equal(later.filter((l) => l.startsWith('- read_page')).length, 40);
  assert.match(later[1], /^- \(\d+ earlier\)$/);
});

const ids = { taskId: 't1', runId: 'r1', stepId: 's1' };
const drain = async (gen) => { for (;;) { const r = await gen.next(); if (r.done) return r.value; } };

test('out of allowance: the server\'s own message, marked so the chat offers an upgrade', async () => {
  const message = 'You’ve used your Lumio AI allowance on the Plus plan for now. Upgrade for more, or try again when it refills.';
  const account = fakeAccount(() => ({ status: 429, error: message, code: 'usage_limit' }));
  await assert.rejects(drain(lumioChat({ account, model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [], context: {}, ids })), (e) => e.message === message && e.code === 'usage_limit');
});

test('"slow down" (too many steps in a minute) waits and tries again instead of ending the task', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const account = fakeAccount((body, n) => (n <= 3 ? { status: 429, error: 'Slow down a little: too many steps in the last minute.', code: 'rate_limited' } : { text: 'Done.' }));
  let result = null;
  const run = drain(lumioChat({ account, model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [], context: {}, ids })).then((r) => { result = r; });
  while (!result) { await new Promise(setImmediate); t.mock.timers.tick(10_000); }
  await run;
  assert.equal(result.content, 'Done.');
  assert.equal(account.bodies.length, 4);
});

test('"slow down" for minutes on end is an error with the server\'s words, not "out of allowance"', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const account = fakeAccount(() => ({ status: 429, error: 'Slow down a little: too many steps in the last minute.', code: 'rate_limited' }));
  let error = null;
  const run = drain(lumioChat({ account, model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [], context: {}, ids })).catch((e) => { error = e; });
  while (!error) { await new Promise(setImmediate); t.mock.timers.tick(10_000); }
  await run;
  assert.equal(error.message, 'Slow down a little: too many steps in the last minute.');
  assert.equal(error.code, undefined);
  assert.equal(account.bodies.length, 13);
});

test('Stop while waiting out a "slow down" ends right away', async () => {
  const ac = new AbortController();
  const account = fakeAccount(() => { setTimeout(() => ac.abort(), 5); return { status: 429, error: 'Slow down a little.', code: 'rate_limited' }; });
  await assert.rejects(drain(lumioChat({ account, model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [], context: {}, ids, signal: ac.signal })), (e) => e.name === 'AbortError');
});
