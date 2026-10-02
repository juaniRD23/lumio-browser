import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../main/sync/crypto.js');

test('the phone companion uses exactly the same sync crypto', () => {
  assert.equal(fs.readFileSync(new URL('../website/public/sync-crypto.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../main/sync/crypto.js', import.meta.url), 'utf8'),
    'copy main/sync/crypto.js to website/public/sync-crypto.js');
});

test('records are sealed per collection and id; the server sees no keys', async () => {
  const raw = C.newKey();
  const keys = await C.deriveKeys(raw);
  const same = await C.deriveKeys(raw);
  assert.equal(keys.check, same.check);
  assert.notEqual(keys.check, (await C.deriveKeys(C.newKey())).check);
  const id = await C.recordId(keys, 'bookmarks', 'https://bank.example/');
  assert.equal(id, await C.recordId(same, 'bookmarks', 'https://bank.example/'));
  assert.doesNotMatch(id, /bank/);
  const data = await C.seal(keys, 'bookmarks', id, { url: 'https://bank.example/', title: 'Bank' });
  assert.doesNotMatch(data, /bank/i);
  assert.deepEqual(await C.open(same, 'bookmarks', id, data), { url: 'https://bank.example/', title: 'Bank' });
  await assert.rejects(C.open(keys, 'passwords', id, data), 'bound to its collection');
  await assert.rejects(C.open(await C.deriveKeys(C.newKey()), 'bookmarks', id, data), 'needs the key');
});

test('the recovery key round-trips and rejects typos', () => {
  const raw = C.newKey();
  const text = C.toRecovery(raw);
  assert.match(text, /^([A-Z2-9]{4}-){12}[A-Z2-9]{4}$/);
  assert.deepEqual(C.fromRecovery(text.toLowerCase().replace(/-/g, ' ')), raw);
  assert.equal(C.fromRecovery(text.slice(0, -1)), null);
  assert.equal(C.fromRecovery(text.replace(/^./, '0')), null);
});

test('pairing hands the sync key to a new device, and both show the same code', async () => {
  const raw = C.newKey();
  const phone = await C.pairKeyPair();
  const code = await C.pairCode(phone.publicKey);
  assert.match(code, /^\d{6}$/);
  const { approverPub, wrapped } = await C.wrapForDevice(raw, phone.publicKey);
  assert.deepEqual(await C.unwrapFromApprover(phone.privateKey, approverPub, wrapped), raw);
  const stranger = await C.pairKeyPair();
  await assert.rejects(C.unwrapFromApprover(stranger.privateKey, approverPub, wrapped));
});
