// Passkeys: Lumio's authenticator, checked the way a website's server would
// check it (parse the attestation, verify the assertion signature).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PasskeyStore, validRpId, cborDecode, AAGUID } = require('../main/passkeys.js');
const adapters = require('../main/sync/adapters.js');

// safeStorage stand-in (reversible, but never plain text on disk).
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('hex')),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString(),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-pk-'));
const b64 = (b) => Buffer.from(b).toString('base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();
const ORIGIN = 'https://login.example.com';
const createOptions = (extra = {}) => ({
  challenge: b64(crypto.randomBytes(32)), rp: { id: 'example.com', name: 'Example' },
  user: { id: b64(Buffer.from('user-123')), name: 'sam@example.com', displayName: 'Sam' },
  pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, ...extra,
});

test('a new passkey is a valid "none" attestation for the site, with an ES256 public key', () => {
  const dir = tmp();
  const store = new PasskeyStore(dir, safe);
  const opts = createOptions();
  const c = store.create(opts, ORIGIN, { verified: true });
  const client = JSON.parse(Buffer.from(c.clientDataJSON, 'base64url'));
  assert.deepEqual(client, { type: 'webauthn.create', challenge: opts.challenge, origin: ORIGIN, crossOrigin: false });
  const [att] = cborDecode(Buffer.from(c.attestationObject, 'base64url'));
  assert.equal(att.get('fmt'), 'none');
  assert.equal(att.get('attStmt').size, 0);
  const auth = att.get('authData');
  assert.deepEqual(auth.subarray(0, 32), sha256('example.com'), 'RP ID hash');
  assert.equal(auth[32], 0x4d, 'user present + verified + backup eligible (Lumio Sync) + attested data, not backed up yet');
  assert.deepEqual(auth.subarray(37, 53), AAGUID);
  const idLen = auth.readUInt16BE(53);
  assert.equal(b64(auth.subarray(55, 55 + idLen)), c.id);
  const [cose] = cborDecode(auth, 55 + idLen);
  assert.equal(cose.get(1), 2);
  assert.equal(cose.get(3), -7);
  // The COSE key and the SPKI key are the same key.
  const spki = crypto.createPublicKey({ key: Buffer.from(c.publicKey, 'base64url'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
  assert.equal(spki.x, b64(cose.get(-2)));
  assert.equal(spki.y, b64(cose.get(-3)));
  // The private key is never stored in plain text.
  const raw = fs.readFileSync(path.join(dir, 'passkeys.json'), 'utf8');
  assert.ok(!raw.includes('BEGIN') && JSON.parse(raw).keys[0].key.length > 40);
  assert.deepEqual(store.list().map((k) => [k.rpId, k.userName]), [['example.com', 'sam@example.com']]);
});

test('signing in: the assertion verifies with the registered key, and returns the user handle', () => {
  const store = new PasskeyStore(tmp(), safe);
  const reg = store.create(createOptions(), ORIGIN, { verified: true });
  const challenge = b64(crypto.randomBytes(32));
  const { list } = store.candidates({ challenge, rpId: 'example.com' }, ORIGIN);
  assert.equal(list.length, 1);
  const a = store.assert({ challenge, rpId: 'example.com', userVerification: 'required' }, ORIGIN, list[0].id, { verified: true });
  const authData = Buffer.from(a.authenticatorData, 'base64url');
  const clientData = Buffer.from(a.clientDataJSON, 'base64url');
  assert.equal(JSON.parse(clientData).type, 'webauthn.get');
  assert.equal(JSON.parse(clientData).challenge, challenge);
  assert.deepEqual(authData.subarray(0, 32), sha256('example.com'));
  assert.equal(authData[32], 0x0d);
  const key = crypto.createPublicKey({ key: Buffer.from(reg.publicKey, 'base64url'), format: 'der', type: 'spki' });
  const ok = crypto.verify('sha256', Buffer.concat([authData, sha256(clientData)]), { key, dsaEncoding: 'der' }, Buffer.from(a.signature, 'base64url'));
  assert.equal(ok, true, 'signature verifies like a website would check it');
  assert.equal(Buffer.from(a.userHandle, 'base64url').toString(), 'user-123');
  // allowCredentials limits the choice; a forged origin can't use it.
  assert.equal(store.candidates({ challenge, allowCredentials: [{ id: 'nope' }] }, ORIGIN).list.length, 0);
  assert.throws(() => store.candidates({ challenge, rpId: 'example.com' }, 'https://evil.com'), { name: 'SecurityError' });
});

test('rules: RP IDs, excluded credentials, algorithms, verification', () => {
  assert.equal(validRpId('example.com', 'https://a.b.example.com'), true);
  assert.equal(validRpId('example.com', 'https://example.com.evil.net'), false);
  assert.equal(validRpId('com', 'https://example.com'), false);
  assert.equal(validRpId('co.uk', 'https://shop.co.uk'), false);
  assert.equal(validRpId('github.io', 'https://me.github.io'), false);
  assert.equal(validRpId('me.github.io', 'https://me.github.io'), true);
  assert.equal(validRpId('example.com', 'http://example.com'), false, 'https only');
  assert.equal(validRpId('localhost', 'http://localhost:8080'), true);
  assert.equal(validRpId('127.0.0.1', 'http://127.0.0.1:8080'), false, 'no IPs');
  const store = new PasskeyStore(tmp(), safe);
  const first = store.create(createOptions(), ORIGIN, { verified: true });
  assert.throws(() => store.create(createOptions({ excludeCredentials: [{ type: 'public-key', id: first.id }] }), ORIGIN, { verified: true }), { name: 'InvalidStateError' });
  assert.throws(() => store.create(createOptions({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }), ORIGIN, { verified: true }), { name: 'NotSupportedError' });
  assert.throws(() => store.create(createOptions({ authenticatorSelection: { userVerification: 'required' } }), ORIGIN, { verified: false }), { name: 'NotAllowedError' });
  assert.throws(() => store.create(createOptions({ rp: { id: 'other.com' } }), ORIGIN, { verified: true }), { name: 'SecurityError' });
  assert.equal(store.remove(first.id), true);
  assert.equal(store.list().length, 0);
});

test('sync: a passkey made before syncing stays device-bound; others go out with their key and come back usable', () => {
  const a = new PasskeyStore(tmp(), safe);
  const synced = a.create(createOptions(), ORIGIN, { verified: true });
  const old = a.create(createOptions({ user: { id: b64(Buffer.from('user-9')), name: 'old@example.com' } }), ORIGIN, { verified: true });
  delete a.find(old.id).be; // as saved before Lumio synced passkeys
  const challenge = b64(crypto.randomBytes(32));
  assert.equal(Buffer.from(a.assert({ challenge, rpId: 'example.com' }, ORIGIN, old.id, { verified: true }).authenticatorData, 'base64url')[32], 0x05, 'it keeps saying device-bound');
  const out = adapters.passkeys(a).entries();
  assert.deepEqual(out.map((e) => e.key), [synced.id]);
  const record = out[0].get();
  assert.equal(record.rpId, 'example.com');
  // Applied on another computer: stored encrypted, and it signs.
  const dir = tmp();
  const b = new PasskeyStore(dir, safe);
  assert.deepEqual(adapters.passkeys(b).apply([{ key: synced.id, record }, { key: 'broken', record: { ...record, key: 'nope' } }]), ['broken']);
  assert.ok(!fs.readFileSync(path.join(dir, 'passkeys.json'), 'utf8').includes(record.key), 'the key is encrypted on disk');
  assert.equal(adapters.passkeys(b).hashOf(record), out[0].hash, 'same record, same hash: no echo');
  const sig = b.assert({ challenge, rpId: 'example.com' }, ORIGIN, synced.id, { verified: true });
  const key = crypto.createPublicKey({ key: Buffer.from(synced.publicKey, 'base64url'), format: 'der', type: 'spki' });
  assert.equal(crypto.verify('sha256', Buffer.concat([Buffer.from(sig.authenticatorData, 'base64url'), sha256(Buffer.from(sig.clientDataJSON, 'base64url'))]), { key, dsaEncoding: 'der' }, Buffer.from(sig.signature, 'base64url')), true);
  adapters.passkeys(b).apply([{ key: synced.id, record: null }]);
  assert.equal(b.list().length, 0, 'deleted elsewhere, deleted here');
});
