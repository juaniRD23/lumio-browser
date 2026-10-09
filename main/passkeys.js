// Passkeys (WebAuthn): Lumio is the authenticator. When a website asks to
// create or use a passkey, Lumio makes or uses an ES256 (P-256) key pair. The
// private key is encrypted with safeStorage, like saved passwords, and Lumio
// Sync carries it to the person's other computers, encrypted with the
// account's sync key (docs/sync-managed.md), so new passkeys tell sites they
// can be backed up (and are, while Sync is on).
// Passkeys made before Lumio synced them said they were device-bound, which a
// passkey can't change later: those stay on their computer.
// This file is the authenticator itself (no UI); password-manager.js asks the
// person and confirms it's them (Touch ID / Windows Hello) first.
const crypto = require('crypto');
const { JsonFile } = require('./store');

// Lumio's authenticator model id (AAGUID), so sites can show "Lumio" as the provider.
const AAGUID = Buffer.from('lumio-passkey-v1', 'latin1'); // 16 bytes
const ES256 = -7;
// Authenticator data flags.
const UP = 0x01; // user present
const UV = 0x04; // user verified
const BE = 0x08; // backup eligible (synced passkey)
const BS = 0x10; // backed up right now
const AT = 0x40; // attested credential data follows

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// ---------------------------------------------------------------- CBOR (just what WebAuthn needs)
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, s.length), s]); }
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error('cbor: unsupported value');
}

// Reads CBOR back (tests use it to check our output like a website would).
function cborDecode(buf, at = 0) {
  const b = buf[at];
  const major = b >> 5;
  let info = b & 31;
  let p = at + 1;
  let n = info;
  if (info === 24) { n = buf[p]; p += 1; } else if (info === 25) { n = buf.readUInt16BE(p); p += 2; } else if (info === 26) { n = buf.readUInt32BE(p); p += 4; }
  if (major === 0) return [n, p];
  if (major === 1) return [-1 - n, p];
  if (major === 2) return [buf.subarray(p, p + n), p + n];
  if (major === 3) return [buf.subarray(p, p + n).toString('utf8'), p + n];
  if (major === 5) {
    const m = new Map();
    for (let i = 0; i < n; i++) { const [k, p1] = cborDecode(buf, p); const [v, p2] = cborDecode(buf, p1); m.set(k, v); p = p2; }
    return [m, p];
  }
  if (major === 4) { const a = []; for (let i = 0; i < n; i++) { const [v, p1] = cborDecode(buf, p); a.push(v); p = p1; } return [a, p]; }
  throw new Error('cbor: unsupported type');
}

// ---------------------------------------------------------------- which sites may use which RP IDs
// An RP ID must be the page's host or a parent domain of it, never a public
// suffix like "com" or "co.uk" (Chromium uses the full Public Suffix List;
// this covers the common ones and every single-label name).
const PUBLIC_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.ar', 'com.mx', 'co.jp', 'ne.jp', 'or.jp', 'co.in', 'co.kr', 'com.cn', 'com.tw', 'co.za', 'com.tr', 'com.sg', 'com.hk',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'glitch.me', 'repl.co', 'onrender.com', 'fly.dev', 'ngrok.io', 'ngrok-free.app']);
function validRpId(rpId, origin) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  const host = u.hostname.toLowerCase();
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && (host === 'localhost' || host.endsWith('.localhost')));
  if (!secure || !rpId || typeof rpId !== 'string') return false;
  rpId = rpId.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false; // no IP addresses
  if (rpId === host) return !PUBLIC_SUFFIXES.has(rpId);
  if (!host.endsWith('.' + rpId)) return false;
  return rpId.includes('.') && !PUBLIC_SUFFIXES.has(rpId);
}

class WebAuthnError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}

// ---------------------------------------------------------------- the store
class PasskeyStore {
  constructor(dir, safeStorage) {
    this.safe = safeStorage;
    this.file = new JsonFile(dir, 'passkeys.json', { version: 1, keys: [] });
    if (!Array.isArray(this.file.data.keys)) this.file.data = { version: 1, keys: [] };
    this.backedUp = () => false; // main/main.js: true while Lumio Sync carries passkeys
  }

  available() { return !!this.safe?.isEncryptionAvailable(); }
  get keys() { return this.file.data.keys; }
  forRp(rpId) { return this.keys.filter((k) => k.rpId === rpId); }
  find(id) { return this.keys.find((k) => k.id === id) || null; }

  // What the Passwords page may see.
  list() {
    return this.keys.map((k) => ({ id: k.id, rpId: k.rpId, userName: k.userName, displayName: k.displayName, created: k.created, lastUsed: k.lastUsed || null, syncable: !!k.be }))
      .sort((a, b) => a.rpId.localeCompare(b.rpId) || a.userName.localeCompare(b.userName));
  }

  remove(id) {
    const before = this.keys.length;
    this.file.data.keys = this.keys.filter((k) => k.id !== id);
    this.file.save();
    return this.keys.length !== before;
  }

  privateKey(k) {
    const der = this.safe.decryptString(Buffer.from(k.key, 'base64'));
    return crypto.createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' });
  }

  // navigator.credentials.create(): a new passkey for this site and account.
  // `pk` is the page's publicKey options with binary fields as base64url.
  create(pk, origin, { verified }) {
    if (!this.available()) throw new WebAuthnError('NotAllowedError', 'Lumio can’t store passkeys on this computer.');
    const rpId = String(pk?.rp?.id || new URL(origin).hostname).toLowerCase();
    if (!validRpId(rpId, origin)) throw new WebAuthnError('SecurityError', 'This site can’t use that passkey domain.');
    const algs = (pk.pubKeyCredParams || []).map((p) => p?.alg);
    if (algs.length && !algs.includes(ES256)) throw new WebAuthnError('NotSupportedError', 'Lumio passkeys use ES256, which this site doesn’t accept.');
    const userId = fromB64url(pk?.user?.id);
    if (!userId.length || userId.length > 64) throw new WebAuthnError('TypeError', 'Invalid user id.');
    const challenge = fromB64url(pk.challenge);
    if (challenge.length < 16) throw new WebAuthnError('TypeError', 'Invalid challenge.');
    const mine = new Set(this.forRp(rpId).map((k) => k.id));
    if ((pk.excludeCredentials || []).some((c) => mine.has(String(c?.id)))) throw new WebAuthnError('InvalidStateError', 'You already have a passkey for this account in Lumio.');
    if (pk.authenticatorSelection?.userVerification === 'required' && !verified) throw new WebAuthnError('NotAllowedError', 'Lumio couldn’t confirm it’s you.');

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credId = crypto.randomBytes(32);
    const cose = cbor(new Map([[1, 2], [3, ES256], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]));
    const flags = UP | (verified ? UV : 0) | BE | (this.backedUp() ? BS : 0) | AT;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    const authData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), Buffer.alloc(4), AAGUID, len, credId, cose]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: b64url(challenge), origin, crossOrigin: false }));
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));

    const now = Date.now();
    this.keys.push({
      id: b64url(credId), rpId, userId: b64url(userId),
      userName: String(pk.user?.name || '').slice(0, 200), displayName: String(pk.user?.displayName || '').slice(0, 200),
      key: this.safe.encryptString(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')).toString('base64'),
      created: now, lastUsed: now, be: true,
    });
    this.file.save(true);
    return {
      id: b64url(credId), clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), authenticatorData: b64url(authData),
      publicKey: b64url(publicKey.export({ format: 'der', type: 'spki' })), publicKeyAlgorithm: ES256, transports: ['internal', 'hybrid'],
      credProps: !!pk.extensions?.credProps,
    };
  }

  // Which saved passkeys can answer this navigator.credentials.get().
  candidates(pk, origin) {
    const rpId = String(pk?.rpId || new URL(origin).hostname).toLowerCase();
    if (!validRpId(rpId, origin)) throw new WebAuthnError('SecurityError', 'This site can’t use that passkey domain.');
    const allow = (pk.allowCredentials || []).map((c) => String(c?.id));
    const list = this.forRp(rpId).filter((k) => !allow.length || allow.includes(k.id));
    return { rpId, list };
  }

  // navigator.credentials.get() with the passkey the person chose.
  assert(pk, origin, id, { verified }) {
    const { rpId, list } = this.candidates(pk, origin);
    const k = list.find((x) => x.id === id);
    if (!k) throw new WebAuthnError('NotAllowedError', 'That passkey isn’t available for this site.');
    if (pk.userVerification === 'required' && !verified) throw new WebAuthnError('NotAllowedError', 'Lumio couldn’t confirm it’s you.');
    const challenge = fromB64url(pk.challenge);
    if (challenge.length < 16) throw new WebAuthnError('TypeError', 'Invalid challenge.');
    const flags = UP | (verified ? UV : 0) | (k.be ? BE | (this.backedUp() ? BS : 0) : 0);
    const authData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), Buffer.alloc(4)]); // sign count 0: not tracked
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), { key: this.privateKey(k), dsaEncoding: 'der' });
    k.lastUsed = Date.now();
    this.file.save();
    return { id: k.id, clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: k.userId };
  }

  // ---------------------------------------------------------------- Lumio Sync
  // A passkey for sync, private key included (the sync engine encrypts it
  // with the account's sync key), and other computers' passkeys stored here.
  syncRecord(id) {
    const k = this.find(id);
    if (!k?.be) return null;
    let key;
    try { key = this.safe.decryptString(Buffer.from(k.key, 'base64')); } catch { return null; }
    return { rpId: k.rpId, userId: k.userId, userName: k.userName, displayName: k.displayName, created: k.created, key };
  }

  applySynced(changes) {
    if (!this.available()) return changes.map((c) => c.key);
    const rejected = [];
    for (const { key: id, record: r } of changes) {
      const i = this.keys.findIndex((k) => k.id === id);
      if (!r) { if (i >= 0) this.keys.splice(i, 1); continue; }
      try {
        if (typeof r.rpId !== 'string' || !r.rpId || !fromB64url(r.userId).length) throw new Error('bad');
        crypto.createPrivateKey({ key: Buffer.from(String(r.key), 'base64'), format: 'der', type: 'pkcs8' }); // a real key
      } catch { rejected.push(id); continue; }
      const fields = {
        rpId: r.rpId.toLowerCase(), userId: String(r.userId), userName: String(r.userName || '').slice(0, 200), displayName: String(r.displayName || '').slice(0, 200),
        key: this.safe.encryptString(String(r.key)).toString('base64'), created: Number(r.created) || Date.now(), be: true,
      };
      if (i >= 0) Object.assign(this.keys[i], fields);
      else this.keys.push({ id, ...fields, lastUsed: null });
    }
    this.file.save(true);
    return rejected;
  }
}

module.exports = { PasskeyStore, WebAuthnError, validRpId, cbor, cborDecode, AAGUID, ES256 };
