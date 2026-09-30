import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSSEParser, createToolCallAccumulator, friendlyError } = require('../main/ai/openrouter.js');

test('SSE parser handles split chunks, comments and [DONE]', () => {
  const p = createSSEParser();
  const a = p.feed(': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"Hel');
  assert.equal(a.length, 0);
  const b = p.feed('lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\r\n\ndata: [DONE]\n\n');
  assert.equal(b.length, 3);
  assert.equal(b[0].json.choices[0].delta.content, 'Hello');
  assert.equal(b[1].json.choices[0].delta.content, ' there');
  assert.equal(b[2].done, true);
  assert.deepEqual(p.end(), []);
});

test('tool call deltas assemble by index', () => {
  const acc = createToolCallAccumulator();
  acc.add([{ index: 0, id: 'call_1', function: { name: 'click', arguments: '{"re' } }]);
  acc.add([{ index: 1, id: 'call_2', function: { name: 'read_page', arguments: '' } }]);
  acc.add([{ index: 0, function: { arguments: 'f": 4}' } }]);
  const calls = acc.result();
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].arguments), { ref: 4 });
  assert.equal(calls[1].name, 'read_page');
  assert.equal(calls[1].arguments, '{}');
});

test('friendly errors', () => {
  assert.match(friendlyError(401, {}), /rejected your API key/);
  assert.match(friendlyError(402, {}), /out of credits/);
  assert.match(friendlyError(404, { error: { message: 'No endpoints found that support image input' } }), /can't read images/);
});
