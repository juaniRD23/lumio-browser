// Lumio Sync's encryption, shared by Lumio Browser (main process, via
// require) and the phone companion (website/public/sync-crypto.js is an exact
// copy, loaded as a plain script: window.LumioSyncCrypto). Uses WebCrypto in
// both places.
//
// Everything synced is encrypted on the device with a 32-byte sync key that
// never reaches Lumio's server:
// - each record: AES-256-GCM, with its collection and id bound in;
// - each record's id: an HMAC of its collection and key (the server can't
//   see which sites are bookmarked or saved);
// - a check value lets a device tell whether its key matches the account's.
// A new device gets the key from one that has it (ECDH P-256, after the person
// approves and the 6-digit codes on both screens match), or from the
// recovery key the person wrote down.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LumioSyncCrypto = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const subtle = globalThis.crypto.subtle;
  const te = new TextEncoder();
  const td = new TextDecoder();

  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const b64url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  function newKey() { return globalThis.crypto.getRandomValues(new Uint8Array(32)); }

  // The record key, the id key and the check value, all from the sync key.
  async function deriveKeys(raw) {
    const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('lumio-sync-v1'), info: te.encode(info) });
    const aes = await subtle.deriveKey(hkdf('records'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const hmac = await subtle.deriveKey(hkdf('ids'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const check = hex(new Uint8Array(await subtle.sign('HMAC', hmac, te.encode('lumio-sync-check')))).slice(0, 32);
    return { aes, hmac, check };
  }

  async function recordId(keys, collection, key) {
    return b64url(new Uint8Array(await subtle.sign('HMAC', keys.hmac, te.encode(`${collection}\n${key}`)))).slice(0, 32);
  }

  // value -> base64(iv || ciphertext); the collection and id are authenticated.
  async function seal(keys, collection, id, value) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`${collection}:${id}`) }, keys.aes, te.encode(JSON.stringify(value))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return toB64(out);
  }

  async function open(keys, collection, id, data) {
    const bytes = fromB64(data);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: te.encode(`${collection}:${id}`) }, keys.aes, bytes.subarray(12));
    return JSON.parse(td.decode(pt));
  }

  // ---------------------------------------------------------------- recovery key
  // 32 bytes as 13 groups of 4 letters and digits (no 0/O/1/I to misread).
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function toRecovery(raw) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const b of raw) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
    return out.match(/.{1,4}/g).join('-');
  }
  function fromRecovery(text) {
    const clean = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 52 || [...clean].some((c) => !ALPHABET.includes(c))) return null;
    const out = [];
    let bits = 0;
    let value = 0;
    for (const c of clean) {
      value = (value << 5) | ALPHABET.indexOf(c);
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return out.length === 32 ? new Uint8Array(out) : null;
  }

  // ---------------------------------------------------------------- pairing
  // The new device makes a key pair and asks; a device that has the sync key
  // sends it back encrypted to that key pair. Both show the same 6-digit
  // code (from the new device's public key), so a swapped request is noticed.
  async function pairKeyPair() {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    return { privateKey: pair.privateKey, publicKey: toB64(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))) };
  }
  async function sharedKey(privateKey, theirPubB64) {
    const pub = await subtle.importKey('raw', fromB64(theirPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
    const base = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('lumio-pair-v1'), info: te.encode('wrap') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function wrapForDevice(raw, devicePubB64) {
    const mine = await pairKeyPair();
    const key = await sharedKey(mine.privateKey, devicePubB64);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, raw));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return { approverPub: mine.publicKey, wrapped: toB64(out) };
  }
  async function unwrapFromApprover(privateKey, approverPubB64, wrapped) {
    const key = await sharedKey(privateKey, approverPubB64);
    const bytes = fromB64(wrapped);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
  }
  async function pairCode(devicePubB64) {
    const d = new Uint8Array(await subtle.digest('SHA-256', fromB64(devicePubB64)));
    const n = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
    return String(n % 1000000).padStart(6, '0');
  }

  async function sha256(text) { return hex(new Uint8Array(await subtle.digest('SHA-256', te.encode(text)))); }

  return { newKey, deriveKeys, recordId, seal, open, toRecovery, fromRecovery, pairKeyPair, wrapForDevice, unwrapFromApprover, pairCode, sha256, toB64, fromB64 };
}));
