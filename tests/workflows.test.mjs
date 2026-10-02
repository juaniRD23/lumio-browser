import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Workflows, normalize, fill, blanksIn } = require('../main/workflows.js');
const { tools } = require('../main/ai/tools/workflow.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-wf-'));

test('blanks in the instructions become questions asked at run time', () => {
  assert.deepEqual(blanksIn('Find the cheapest {item} under {max price}, then {item} reviews'), [{ name: 'item', label: 'Item' }, { name: 'max_price', label: 'Max price' }]);
  const w = normalize({ title: 'Cheaper', instructions: 'Search Amazon and Best Buy for {item}.', inputs: [{ name: 'item', label: 'What to look for' }], start_url: 'amazon.com' });
  assert.deepEqual(w.inputs, [{ name: 'item', label: 'What to look for' }]);
  assert.equal(w.startUrl, 'https://amazon.com');
  assert.equal(fill(w, { item: 'AirPods Pro' }), 'Search Amazon and Best Buy for AirPods Pro.');
  assert.throws(() => fill(w, {}), /Fill in What to look for/);
  assert.throws(() => normalize({ title: '', instructions: 'x' }), /name/);
  assert.throws(() => normalize({ title: 'x', instructions: '' }), /what the workflow should do/);
});

test('saving the same name updates it; runs are counted; it survives a restart', () => {
  const dir = tmp();
  const s = new Workflows(dir);
  const a = s.add({ title: 'Morning news', instructions: 'Read the top 3 stories on apnews.com.' });
  const b = s.add({ title: 'morning NEWS', instructions: 'Read the top 5 stories on apnews.com.' });
  assert.equal(a.id, b.id);
  assert.equal(s.list().length, 1);
  assert.match(s.get(a.id).instructions, /top 5/);
  s.ran(a.id);
  s.update(a.id, { startUrl: 'https://apnews.com/' });
  const again = new Workflows(dir);
  assert.equal(again.get(a.id).runs, 1);
  assert.equal(again.get(a.id).startUrl, 'https://apnews.com/');
});

test('sync records round-trip', () => {
  const s = new Workflows(tmp());
  const w = s.add({ title: 'A', instructions: 'Do {thing}.' });
  const other = new Workflows(tmp());
  for (const [id, rec] of Object.entries(s.records())) other.applyRemote(id, rec);
  assert.equal(other.get(w.id).title, 'A');
  other.applyRemote(w.id, null);
  assert.equal(other.list().length, 0);
});

test('the AI saves and lists workflows', () => {
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const ctx = { workflows: new Workflows(tmp()) };
  const out = by.save_workflow.run({ title: 'Price check', instructions: 'Check the price of {item} on bestbuy.com.', inputs: [{ name: 'item', label: 'Product' }] }, ctx);
  assert.match(out.text, /Saved the workflow “Price check”[\s\S]*asks for Product each time/);
  assert.match(by.list_workflows.run({}, ctx).text, /“Price check”[\s\S]*blanks: \{item\}[\s\S]*bestbuy\.com/);
});
