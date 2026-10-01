// What the browser sends the Lumio server for each AI step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trimForServer } = require('../main/ai/lumio.js');

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
  assert.equal(out[1].role, 'assistant', 'then a model turn with its results');
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
