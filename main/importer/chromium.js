// Import bookmarks, history and passwords from Chromium browsers on this
// computer (Chrome, Brave, Edge, Arc, Vivaldi, Chromium). Bookmarks are a JSON
// file; history and passwords are SQLite databases we copy first, since the
// browser may have them locked.
// Passwords (Mac only): each browser encrypts them with a key it keeps in the
// macOS Keychain ("Chrome Safe Storage"...). Reading that key makes macOS ask
// the person to allow it; then they're decrypted here (AES-128-CBC, "v10").
// On Windows, Chrome locks passwords to itself, so people import a CSV export.
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
// Profile folders under ~/Library/Application Support (macOS) or %LOCALAPPDATA% (Windows).
// keychain: the macOS Keychain item holding that browser's password key.
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', dir: WIN ? 'Google/Chrome/User Data' : 'Google/Chrome', keychain: ['Chrome Safe Storage', 'Chrome'] },
  { id: 'edge', name: 'Microsoft Edge', dir: WIN ? 'Microsoft/Edge/User Data' : 'Microsoft Edge', keychain: ['Microsoft Edge Safe Storage', 'Microsoft Edge'] },
  { id: 'brave', name: 'Brave', dir: WIN ? 'BraveSoftware/Brave-Browser/User Data' : 'BraveSoftware/Brave-Browser', keychain: ['Brave Safe Storage', 'Brave'] },
  { id: 'arc', name: 'Arc', dir: WIN ? null : 'Arc/User Data', keychain: ['Arc Safe Storage', 'Arc'] },
  { id: 'vivaldi', name: 'Vivaldi', dir: WIN ? 'Vivaldi/User Data' : 'Vivaldi', keychain: ['Vivaldi Safe Storage', 'Vivaldi'] },
  { id: 'chromium', name: 'Chromium', dir: WIN ? 'Chromium/User Data' : 'Chromium', keychain: ['Chromium Safe Storage', 'Chromium'] },
].filter((b) => b.dir);

// Tests point this at a fake support folder.
const supportDir = () => process.env.LUMIO_IMPORT_ROOT
  || (WIN ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), 'Library', 'Application Support'));

const hasData = (dir) => ['Bookmarks', 'History', 'Login Data'].some((f) => fs.existsSync(path.join(dir, f)));

// The browser's profiles that have something to import, with the names the
// browser shows (from its Local State file), the one used last first.
function profiles(browser) {
  const base = path.join(supportDir(), browser.dir);
  let info = {};
  let order = [];
  try {
    const p = JSON.parse(fs.readFileSync(path.join(base, 'Local State'), 'utf8')).profile || {};
    info = p.info_cache || {};
    order = [p.last_used, ...(p.profiles_order || [])];
  } catch { /* no Local State: look for the usual folders */ }
  let found = [];
  try { found = fs.readdirSync(base).filter((n) => n === 'Default' || /^Profile \d+$/.test(n)); } catch { /* not installed */ }
  const dirs = [...new Set([...order, ...Object.keys(info), 'Default', ...found.sort()])]
    .filter((d) => typeof d === 'string' && d && !d.includes('/') && !d.includes('\\') && d !== '..' && hasData(path.join(base, d)));
  return dirs.map((d) => ({ dir: d, path: path.join(base, d), name: String(info[d]?.name || info[d]?.gaia_name || d).slice(0, 60) }));
}

// One entry per browser, or per profile when it has several ("chrome:Profile 2").
function detect() {
  return BROWSERS.flatMap((b) => {
    const list = profiles(b);
    const one = (p, many) => ({ id: many ? `${b.id}:${p.dir}` : b.id, name: many ? `${b.name} (${p.name})` : b.name, kind: 'chromium', passwords: process.platform === 'darwin' });
    return list.length > 1 ? list.map((p) => one(p, true)) : list.map((p) => one(p, false));
  });
}

// "chrome" (its first profile) or "chrome:Profile 2" -> { browser, profile }.
function resolve(id) {
  const [bid, dir] = String(id).split(/:(.*)/s);
  const browser = BROWSERS.find((b) => b.id === bid);
  const list = browser ? profiles(browser) : [];
  const profile = dir ? list.find((p) => p.dir === dir) : list[0];
  return profile ? { browser, profile } : null;
}

// Chromium time: microseconds since 1601-01-01. These are bigger than
// Number.MAX_SAFE_INTEGER, so SQLite hands them over as BigInt.
const EPOCH_DIFF_MS = 11644473600000;
const fromChromeTime = (t) => (typeof t === 'bigint' ? Number(t / 1000n) : Math.round(Number(t) / 1000)) - EPOCH_DIFF_MS;
const toChromeTime = (ms) => (BigInt(Math.round(ms)) + BigInt(EPOCH_DIFF_MS)) * 1000n;

// { bar, other, mobile }, with folders.
function readBookmarks(profile) {
  const file = path.join(profile, 'Bookmarks');
  if (!fs.existsSync(file)) return { bar: [], other: [], mobile: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const time = (node) => { try { if (node.date_added) return fromChromeTime(BigInt(node.date_added)); } catch { /* keep now */ } return Date.now(); };
  const list = (node, depth = 0) => (depth > 40 ? [] : (node?.children || []).flatMap((n) => {
    if (n.type === 'folder') return [{ title: n.name || 'Folder', time: time(n), children: list(n, depth + 1) }];
    return n.type === 'url' && n.url ? [{ url: n.url, title: n.name || n.url, time: time(n) }] : [];
  }));
  const r = data.roots || {};
  return { bar: list(r.bookmark_bar), other: list(r.other), mobile: list(r.synced) };
}

function readHistory(profile, { days = 90, limit = 20000 } = {}) {
  const file = path.join(profile, 'History');
  if (!fs.existsSync(file)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-import-'));
  const copy = path.join(tmp, 'History');
  try {
    fs.copyFileSync(file, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    const query = db.prepare(
      `SELECT u.url AS url, u.title AS title, v.visit_time AS t
         FROM visits v JOIN urls u ON u.id = v.url
        WHERE v.visit_time > ? AND (u.url LIKE 'http://%' OR u.url LIKE 'https://%')
        ORDER BY v.visit_time DESC LIMIT ?`,
    );
    query.setReadBigInts(true);
    const rows = query.all(toChromeTime(Date.now() - days * 86400000), limit);
    db.close();
    return rows.map((r) => ({ url: r.url, title: r.title || r.url, time: fromChromeTime(r.t) }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The browser's password key from the macOS Keychain (macOS asks the person).
function keychainSecret([service, account]) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', service, '-a', account], { timeout: 180_000 }, (err, stdout) => {
      if (err) reject(new Error(err.code === 44 ? 'not found' : 'denied'));
      else resolve(String(stdout).trim());
    });
  });
}

// Saved sign-ins: [{ url, username, password }]. `secret` (tests) skips the Keychain.
async function readPasswords(browser, profile, { secret } = {}) {
  const file = path.join(profile, 'Login Data');
  if (!fs.existsSync(file)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-import-'));
  let rows;
  try {
    const copy = path.join(tmp, 'Login Data');
    fs.copyFileSync(file, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    rows = db.prepare('SELECT origin_url AS url, username_value AS username, password_value AS value FROM logins WHERE blacklisted_by_user = 0').all();
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!rows.length) return [];
  const key = crypto.pbkdf2Sync(secret ?? await keychainSecret(browser.keychain), 'saltysalt', 1003, 16, 'sha1');
  const out = [];
  for (const r of rows) {
    const blob = Buffer.from(r.value || []);
    if (blob.subarray(0, 3).toString() !== 'v10') continue; // only the macOS format
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
      const password = Buffer.concat([d.update(blob.subarray(3)), d.final()]).toString('utf8');
      if (password) out.push({ url: r.url, username: r.username || '', password });
    } catch { /* a value encrypted some other way */ }
  }
  if (rows.length && !out.length) throw new Error('Lumio couldn’t read those passwords.');
  return out;
}

async function importFrom(id, store, { bookmarks = true, history = true, passwords = false, passwordStore = null, secret } = {}) {
  const found = resolve(id);
  if (!found) return { ok: false, error: 'That browser was not found on this computer.' };
  const { browser } = found;
  const profile = found.profile.path;
  const res = { ok: true, browser: browser.name, bookmarks: 0, history: 0, passwords: null };
  try {
    if (bookmarks) res.bookmarks = store.importBookmarks(readBookmarks(profile), { folder: `Imported from ${browser.name}` });
    if (history) res.history = store.importHistory(readHistory(profile));
  } catch (err) {
    return { ok: false, error: `Couldn't read ${browser.name}'s data: ${err.message}` };
  }
  if (passwords && passwordStore) {
    if (process.platform !== 'darwin' && secret == null) {
      res.passwordError = `${browser.name} keeps its passwords locked on Windows. Export them from ${browser.name} as a CSV file and import that instead.`;
    } else {
      try {
        res.passwords = passwordStore.importEntries(await readPasswords(browser, profile, { secret }));
      } catch (err) {
        res.passwordError = err.message === 'denied'
          ? `macOS didn’t let Lumio read ${browser.name}’s passwords. Try again and click Allow, or export them from ${browser.name} as a CSV file.`
          : err.message === 'not found' ? `${browser.name} has no saved passwords to import.` : `Couldn't import ${browser.name}'s passwords: ${err.message}`;
      }
    }
  }
  return res;
}

module.exports = { detect, importFrom, profiles, readBookmarks, readHistory, readPasswords, fromChromeTime, toChromeTime, BROWSERS };
