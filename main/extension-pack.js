// "Pack extension" (developer mode): turns an extension folder into a signed
// .crx file (CRX3, the format the Chrome Web Store and Chrome use) and a .pem
// private key, next to the folder, like Chrome does. Keep the key: packing a
// new version with it keeps the extension's ID. No dependencies: the zip and
// the small protobuf header are written here (tested in
// tests/extension-access.test.mjs).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- zip
// Files only (folders are implied by the paths), deflated, UTF-8 names.
// Hidden files (.git, .DS_Store) and keys are left out, like Chrome does.
function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
      const abs = path.join(dir, e.name);
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, name);
      else if (e.isFile() && !/\.(pem|crx)$/i.test(e.name)) out.push({ abs, name });
    }
  };
  walk(root, '');
  return out;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function zip(root) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of listFiles(root)) {
    const data = fs.readFileSync(f.abs);
    const packed = zlib.deflateRawSync(data);
    const stored = packed.length >= data.length; // tiny files don't shrink
    const body = stored ? data : packed;
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(data);
    const { time, date } = dosTime(fs.statSync(f.abs).mtime);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(stored ? 0 : 8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------- CRX3
const varint = (n) => {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
};
const field = (num, bytes) => Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes]); // length-delimited

// The extension ID is the first 16 bytes of the key's SHA-256, written with a-p.
function idFromKey(spkiDer) {
  return [...crypto.createHash('sha256').update(spkiDer).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
}

function crx3(zipBytes, privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const crxId = crypto.createHash('sha256').update(spki).digest().subarray(0, 16);
  const signedData = field(1, crxId); // SignedData { crx_id }
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  const signature = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00'), size, signedData, zipBytes]), privateKey);
  // CrxFileHeader { sha256_with_rsa = 2: { public_key = 1, signature = 2 }, signed_header_data = 10000 }
  const header = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, signature)])), field(10000, signedData)]);
  const top = Buffer.alloc(12);
  top.write('Cr24', 0, 'latin1');
  top.writeUInt32LE(3, 4);
  top.writeUInt32LE(header.length, 8);
  return { bytes: Buffer.concat([top, header, zipBytes]), id: idFromKey(spki), publicKey: spki.toString('base64') };
}

// Packs `dir` into <dir>.crx. keyFile: an existing .pem to sign with (keeps
// the ID); without one a new key is saved as <dir>.pem, never over one that's
// already there.
function packExtension(dir, keyFile = null) {
  dir = path.resolve(String(dir || ''));
  try { JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return { ok: false, error: 'That folder has no valid manifest.json.' }; }
  const base = dir.replace(/[\\/]+$/, '');
  const crxPath = `${base}.crx`;
  let pemPath = null;
  let key;
  if (keyFile) {
    try { key = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8')); } catch { return { ok: false, error: 'That private key file couldn’t be read.' }; }
  } else {
    pemPath = `${base}.pem`;
    if (fs.existsSync(pemPath)) return { ok: false, error: `A private key already exists at ${pemPath}. Choose it as the key to make a new version.` };
    key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }
  const out = crx3(zip(dir), key);
  fs.writeFileSync(crxPath, out.bytes);
  if (pemPath) fs.writeFileSync(pemPath, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { ok: true, crx: crxPath, pem: pemPath, id: out.id };
}

module.exports = { packExtension, zip, crx3, idFromKey, listFiles };
