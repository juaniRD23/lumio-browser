import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable, pieces } from '../renderer/ui/voice.js';

test('replies are read aloud without Markdown, code or raw links', () => {
  const md = '## Top picks\n\n1. **Sony WH-1000XM6** — [review](https://example.com/r)\n- `$399` at Best Buy\n\n```js\nconsole.log(1)\n```\nSee https://example.com/x for more.';
  const t = speakable(md);
  assert.doesNotMatch(t, /[#*`]|https?:/);
  assert.match(t, /Top picks/);
  assert.match(t, /Sony WH-1000XM6 — review/);
  assert.match(t, /\$399 at Best Buy/);
  assert.match(t, /There’s code in the chat/);
  assert.match(t, /See the link in the chat for more/);
});

test('long replies are cut at a sentence and say where the rest is', () => {
  const t = speakable('This is a sentence. '.repeat(400));
  assert.ok(t.length < 3100);
  assert.match(t, /\. The rest is in the chat\.$/);
});

test('speech is split into pieces at sentence ends', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const list = pieces(text);
  assert.ok(list.length > 1);
  assert.ok(list.every((p) => p.length <= 600));
  assert.equal(list.join(' '), text);
  assert.deepEqual(pieces(''), []);
});
