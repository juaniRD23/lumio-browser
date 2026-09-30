import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runAgent } = require('../main/ai/agent.js');
const { tools, normalizePlan } = require('../main/ai/tools/plan.js');

const updatePlan = tools.find((t) => t.name === 'update_plan');

test('normalizePlan trims titles, fills statuses and enforces limits', () => {
  assert.deepEqual(normalizePlan([{ title: '  Find   flights ', status: 'in_progress' }, { title: 'Book', status: 'weird' }]), [
    { title: 'Find flights', status: 'in_progress' },
    { title: 'Book', status: 'pending' },
  ]);
  assert.throws(() => normalizePlan([]), /1 to 12/);
  assert.throws(() => normalizePlan(Array.from({ length: 13 }, (_, i) => ({ title: `s${i}`, status: 'pending' }))), /12 steps/);
  assert.throws(() => normalizePlan([{ title: '', status: 'done' }]), /title/);
  assert.throws(() => normalizePlan([{ title: 'a', status: 'in_progress' }, { title: 'b', status: 'in_progress' }]), /one step/);
  assert.equal(normalizePlan([{ title: 'x'.repeat(300), status: 'done' }])[0].title.length, 100);
});

test('update_plan never asks, shows no step chip, and reports the plan', async () => {
  const events = [];
  const plans = [];
  const messages = [{ role: 'user', content: 'plan a trip' }];
  const turns = [
    { calls: [{ id: 'p1', name: 'update_plan', arguments: JSON.stringify({ steps: [{ title: 'Pick dates', status: 'in_progress' }, { title: 'Book', status: 'pending' }] }) }] },
    { calls: [{ id: 'p2', name: 'update_plan', arguments: '{"steps":[{"title":"Pick dates","status":"in_progress"},{"title":"Book","status":"in_progress"}]}' }] },
    { text: 'Done.' },
  ];
  let i = 0;
  const chat = async function* () { const t = turns[i++]; if (t.text) yield { type: 'text', text: t.text }; return { content: t.text || '', toolCalls: t.calls || [], finishReason: t.calls ? 'tool_calls' : 'stop' }; };
  await runAgent({
    model: 'm', messages, tools: [updatePlan], systemPrompt: () => 'sys', chat,
    approve: async () => { throw new Error('should not ask'); }, getMode: () => 'ask',
    emit: (e) => events.push(e), ctx: { setPlan: (p) => plans.push(p) },
  });
  assert.equal(events.filter((e) => e.type === 'step' || e.type === 'step_done' || e.type === 'approval').length, 0);
  assert.deepEqual(plans, [[{ title: 'Pick dates', status: 'in_progress' }, { title: 'Book', status: 'pending' }]]);
  const results = messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(results[0], 'Plan updated (0/2 done).');
  assert.match(results[1], /^Error: Only one step/, 'a bad plan goes back to the model as an error');
});
