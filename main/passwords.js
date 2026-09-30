// Saved passwords. Every password (and note) is encrypted on its own with
// safeStorage, whose key lives in the macOS Keychain or is protected by
// Windows (DPAPI). Nothing is ever written in plain text: if encryption isn't
// available, saving is refused. The rest of the app only ever sees usernames
// and sites; secrets are decrypted on demand for filling, or for showing and
// exporting after the person confirms who they are.
const crypto = require('crypto');
const { JsonFile } = require('./store');

// Common passwords count as weak no matter how long they are.
const COMMON = new Set(['password', 'password1', 'password123', '123456', '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123', 'abc123', 'letmein', 'iloveyou', 'admin', 'welcome', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', '111111', '000000']);

function siteKey(origin) {
  try {
    const u = new URL(origin);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.hostname.replace(/^www\./, '')}${u.port ? ':' + u.port : ''}`;
  } catch { return null; }
}

function isWeak(pw) {
  if (!pw || pw.length < 8 || COMMON.has(pw.toLowerCase())) return true;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return pw.length < 12 && kinds < 3;
}

// Strong, readable-enough generated passwords (no look-alike characters).
function generatePassword(length = 18) {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '-_!@#%*?'];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const out = sets.map(pick); // at least one of each kind
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

// Minimal CSV (RFC 4180) for Chrome/Edge/Brave password exports.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}
const csvCell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

class PasswordStore {
  constructor(dir, safeStorage) {
    this.safe = safeStorage;
    this.file = new JsonFile(dir, 'passwords.json', { version: 1, entries: [], never: [] });
    if (!Array.isArray(this.file.data.entries)) this.file.data = { version: 1, entries: [], never: [] };
  }

  available() { return !!this.safe?.isEncryptionAvailable(); }
  enc(text) { return this.safe.encryptString(String(text)).toString('base64'); }
  dec(b64) { try { return this.safe.decryptString(Buffer.from(b64, 'base64')); } catch { return null; } }
  get entries() { return this.file.data.entries; }

  // What the manager page may see: never a password.
  list() {
    const counts = new Map();
    const plain = new Map(this.entries.map((e) => [e.id, this.dec(e.password)]));
    for (const pw of plain.values()) if (pw) counts.set(pw, (counts.get(pw) || 0) + 1);
    return this.entries
      .map((e) => ({
        id: e.id,
        origin: e.origin,
        site: siteKey(e.origin)?.replace(/^https?:\/\//, '') || e.origin,
        username: e.username,
        hasNote: !!e.note,
        created: e.created,
        updated: e.updated,
        lastUsed: e.lastUsed || null,
        weak: isWeak(plain.get(e.id)),
        reused: (counts.get(plain.get(e.id)) || 0) > 1,
      }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
  }

  // Saved accounts for a page's origin (same site, ignoring "www.").
  forOrigin(origin) {
    const key = siteKey(origin);
    if (!key) return [];
    return this.entries.filter((e) => siteKey(e.origin) === key);
  }

  get(id) { return this.entries.find((e) => e.id === id) || null; }
  secret(id) { const e = this.get(id); return e ? this.dec(e.password) : null; }
  note(id) { const e = this.get(id); return e?.note ? this.dec(e.note) : ''; }

  save({ origin, username = '', password, note }) {
    if (!this.available()) throw new Error('Password encryption isn’t available on this system.');
    const key = siteKey(origin);
    if (!key || !password) throw new Error('A site and a password are needed.');
    const now = Date.now();
    const existing = this.forOrigin(origin).find((e) => e.username === username);
    if (existing) {
      existing.password = this.enc(password);
      if (note !== undefined) existing.note = note ? this.enc(note) : null;
      existing.updated = now;
      this.file.save();
      return existing.id;
    }
    const entry = { id: crypto.randomUUID(), origin: new URL(origin).origin, username: String(username).slice(0, 300), password: this.enc(password), note: note ? this.enc(note) : null, created: now, updated: now, lastUsed: null };
    this.entries.push(entry);
    this.file.save();
    return entry.id;
  }

  update(id, { username, password, note, origin } = {}) {
    const e = this.get(id);
    if (!e) return false;
    if (typeof username === 'string') e.username = username.slice(0, 300);
    if (typeof password === 'string' && password) e.password = this.enc(password);
    if (typeof note === 'string') e.note = note ? this.enc(note) : null;
    if (typeof origin === 'string' && siteKey(origin)) e.origin = new URL(origin).origin;
    e.updated = Date.now();
    this.file.save();
    return true;
  }

  remove(id) {
    const before = this.entries.length;
    this.file.data.entries = this.entries.filter((e) => e.id !== id);
    this.file.save(true);
    return this.entries.length < before;
  }

  markUsed(id) {
    const e = this.get(id);
    if (e) { e.lastUsed = Date.now(); this.file.save(); }
  }

  // What a submitted sign-in should lead to: nothing, save, or update.
  classify(origin, username, password) {
    const same = this.forOrigin(origin);
    const match = same.find((e) => e.username === username);
    if (match) return this.dec(match.password) === password ? { action: 'none', id: match.id } : { action: 'update', id: match.id };
    // A password change form without a username: update the only account.
    if (!username && same.length === 1) return this.dec(same[0].password) === password ? { action: 'none', id: same[0].id } : { action: 'update', id: same[0].id };
    return { action: 'save' };
  }

  // Sites where the person chose "Never".
  never() { return [...(this.file.data.never || [])]; }
  isNever(origin) { const key = siteKey(origin); return !!key && (this.file.data.never || []).includes(key); }
  addNever(origin) {
    const key = siteKey(origin);
    if (!key) return;
    this.file.data.never = [...new Set([...(this.file.data.never || []), key])];
    this.file.save();
  }
  removeNever(site) {
    this.file.data.never = (this.file.data.never || []).filter((s) => s !== site);
    this.file.save();
  }

  importCsv(text) {
    const rows = parseCsv(String(text).replace(/^﻿/, ''));
    if (!rows.length) return { added: 0, updated: 0, skipped: 0 };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (names) => head.findIndex((h) => names.includes(h));
    const iUrl = col(['url', 'website', 'login_uri', 'origin']);
    const iUser = col(['username', 'login', 'login_username', 'email']);
    const iPass = col(['password', 'login_password']);
    const iNote = col(['note', 'notes']);
    if (iUrl < 0 || iPass < 0) throw new Error('That file doesn’t look like a password export (it needs url and password columns).');
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const r of rows.slice(1)) {
      const url = (r[iUrl] || '').trim();
      const password = r[iPass] || '';
      if (!siteKey(url) || !password) { skipped++; continue; }
      const username = iUser >= 0 ? r[iUser] || '' : '';
      const c = this.classify(url, username, password);
      if (c.action === 'none') { skipped++; continue; }
      this.save({ origin: url, username, password, note: iNote >= 0 && r[iNote] ? r[iNote] : undefined });
      if (c.action === 'update') updated++; else added++;
    }
    this.file.save(true);
    return { added, updated, skipped };
  }

  exportCsv() {
    const lines = [['name', 'url', 'username', 'password', 'note'].join(',')];
    for (const e of this.entries) {
      const site = siteKey(e.origin)?.replace(/^https?:\/\//, '') || e.origin;
      lines.push([site, e.origin, e.username, this.dec(e.password) || '', e.note ? this.dec(e.note) || '' : ''].map(csvCell).join(','));
    }
    return lines.join('\n') + '\n';
  }
}

module.exports = { PasswordStore, generatePassword, isWeak, parseCsv, siteKey };
