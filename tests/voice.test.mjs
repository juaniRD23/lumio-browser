import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable, pieces, SentenceStream, isEcho, narration, Listener, encodeWav } from '../renderer/ui/voice.js';

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

test('speech is split into pieces at sentence ends', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const list = pieces(text);
  assert.ok(list.length > 1);
  assert.ok(list.every((p) => p.length <= 600));
  assert.equal(list.join(' '), text);
  assert.deepEqual(pieces(''), []);
});

test('streaming text comes out a sentence at a time, and code waits for its end', () => {
  const s = new SentenceStream();
  assert.deepEqual(s.push('Okay, opening '), []);
  assert.deepEqual(s.push('apple.com now. Then I'), ['Okay, opening apple.com now.']);
  assert.deepEqual(s.push('’ll compare prices! Here:\n```js\nconst a = 1.'), ['Then I’ll compare prices!', 'Here:']);
  assert.deepEqual(s.push(' 2;\n```\nDone. '), ['```js\nconst a = 1. 2;\n```', 'Done.']);
  assert.deepEqual(s.push('Last bit'), []);
  assert.deepEqual(s.flush(), ['Last bit']);
  assert.deepEqual(s.flush(), []);
  // Numbers like 3.5 don't end a sentence (no space after the dot).
  assert.deepEqual(new SentenceStream().push('It costs $3.50 today. '), ['It costs $3.50 today.']);
});

test('the microphone hearing Lumio’s own voice is recognized', () => {
  const said = 'I found three options on Best Buy. The cheapest is the Sony at 379 dollars.';
  assert.equal(isEcho('the cheapest is the Sony at 379 dollars', said), true);
  assert.equal(isEcho('actually check Amazon instead', said), false);
  assert.equal(isEcho('', said), true);
  assert.equal(isEcho('stop', ''), false);
});

test('step labels become short spoken updates', () => {
  assert.equal(narration('Reading www.apple.com'), 'Reading apple.com…');
  assert.equal(narration('Click “Add to Bag”'), 'Clicking Add to Bag…');
  assert.equal(narration('Updating the plan'), null);
  assert.equal(narration('x'.repeat(90)), null);
});

// Synthetic microphone input: 32 ms blocks at 16 kHz.
const block = (amp) => Float32Array.from({ length: 512 }, (_, i) => amp * Math.sin(i / 3));
function feed(l, plan, strict = false) {
  const events = [];
  for (const [amp, ms] of plan) {
    for (let t = 0; t < ms; t += 32) {
      const ev = l.push(block(amp), strict);
      if (ev) events.push(ev);
    }
  }
  return events;
}

test('speech start and end are found from loudness, with the moment before it kept', () => {
  const l = new Listener({ endMs: 800 });
  const ev = feed(l, [[0.002, 1000], [0.2, 1200], [0.002, 1200]]);
  assert.equal(ev[0], 'start');
  const clip = ev.find((e) => e.samples);
  assert.ok(clip, 'the phrase ended after the quiet');
  assert.ok(clip.ms > 1200 && clip.ms < 2100, `kept ${clip.ms} ms (speech, lead-in and a little quiet)`);
  assert.equal(l.inSpeech, false);
});

test('a click or cough is ignored, and Lumio’s quieter voice doesn’t interrupt it', () => {
  assert.deepEqual(feed(new Listener(), [[0.002, 800], [0.3, 130], [0.002, 1200]]), ['start', 'discard']);
  // While Lumio talks (strict), moderate sound isn't speech; loud, longer speech is.
  const l = new Listener();
  feed(l, [[0.002, 800]]);
  assert.deepEqual(feed(l, [[0.03, 800]], true), []);
  assert.equal(feed(l, [[0.25, 400]], true)[0], 'start');
});

test('WAV encoding', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]));
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
  assert.equal(wav.length, 44 + 8);
});
