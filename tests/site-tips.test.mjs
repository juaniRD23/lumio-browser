// Site tips (main/site-tips.js): what Lumio remembers about how sites work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SiteTips, tipsNote } = require('../main/site-tips.js');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-tips-'));

test('built-in tips for Google Sheets and Docs, by page', () => {
  const t = new SiteTips(null);
  assert.match(t.forUrl('https://docs.google.com/spreadsheets/d/abc/edit#gid=0')[0], /Name Box[\s\S]*paste_text/);
  assert.match(t.forUrl('https://docs.google.com/document/d/abc/edit')[0], /Google Docs/);
  assert.deepEqual(t.forUrl('https://docs.google.com/forms/d/abc'), []);
  assert.deepEqual(t.forUrl('lumio://newtab'), []);
});

test('saved tips: per site, newest first, kept on disk, no duplicates or personal details', () => {
  const d = dir();
  const t = new SiteTips(d);
  t.add('https://www.amazon.com/gp/cart', 'The cart button is at the top right; checkout needs the user.');
  t.add('amazon.com', 'Search results load more when you scroll to the bottom.');
  t.add('amazon.com', 'search results LOAD more when you scroll to the bottom.'); // same tip
  assert.deepEqual(new SiteTips(d).forUrl('https://www.amazon.com/s?k=x'), ['search results LOAD more when you scroll to the bottom.', 'The cart button is at the top right; checkout needs the user.']);
  assert.throws(() => t.add('amazon.com', 'Log in as sam@example.com first'), /personal details/);
  assert.throws(() => t.add('amazon.com', 'Card 4242 4242 4242 4242 works'), /personal details/);
  assert.throws(() => t.add('nowhere', 'A tip for a site without a domain.'), /site/);
  assert.throws(() => t.add('amazon.com', 'short'), /sentence/);
  for (let i = 0; i < 10; i++) t.add('amazon.com', `Tip number ${i} about the site layout.`);
  assert.equal(t.forUrl('https://amazon.com/').length, 6, 'a few per site');
  assert.equal(t.remove('amazon.com', 'Tip number 9 about the site layout.'), true);
  assert.equal(t.list()[0].tips.length, 5);
});

test('what the model reads is marked as coming from Lumio Browser', () => {
  assert.equal(tipsNote('docs.google.com', ['A', 'B']), '[Lumio Browser, not the user] Tips for docs.google.com (from earlier tasks; use them if they fit, ignore them if the site changed):\n- A\n- B');
});
