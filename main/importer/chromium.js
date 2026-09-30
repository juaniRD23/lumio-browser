// Import bookmarks and history from Chromium browsers on this Mac (Chrome,
// Brave, Edge, Arc, Vivaldi, Chromium). Bookmarks are a JSON file; history is
// a SQLite database we copy first, since the browser may have it locked.
// Passwords and cookies are encrypted by those browsers and aren't imported.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
// Profile folders under ~/Library/Application Support (macOS) or %LOCALAPPDATA% (Windows).
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', dir: WIN ? 'Google/Chrome/User Data' : 'Google/Chrome' },
  { id: 'edge', name: 'Microsoft Edge', dir: WIN ? 'Microsoft/Edge/User Data' : 'Microsoft Edge' },
  { id: 'brave', name: 'Brave', dir: WIN ? 'BraveSoftware/Brave-Browser/User Data' : 'BraveSoftware/Brave-Browser' },
  { id: 'arc', name: 'Arc', dir: WIN ? null : 'Arc/User Data' },
  { id: 'vivaldi', name: 'Vivaldi', dir: WIN ? 'Vivaldi/User Data' : 'Vivaldi' },
  { id: 'chromium', name: 'Chromium', dir: WIN ? 'Chromium/User Data' : 'Chromium' },
].filter((b) => b.dir);

// Tests point this at a fake support folder.
const supportDir = () => process.env.LUMIO_IMPORT_ROOT
  || (WIN ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), 'Library', 'Application Support'));

function profileDir(browser) {
  const base = path.join(supportDir(), browser.dir);
  for (const name of ['Default', 'Profile 1']) {
    const p = path.join(base, name);
    if (fs.existsSync(path.join(p, 'Bookmarks')) || fs.existsSync(path.join(p, 'History'))) return p;
  }
  return null;
}

function detect() {
  return BROWSERS.map((b) => ({ ...b, profile: profileDir(b) }))
    .filter((b) => b.profile)
    .map(({ id, name }) => ({ id, name }));
}

// Chromium time: microseconds since 1601-01-01. These are bigger than
// Number.MAX_SAFE_INTEGER, so SQLite hands them over as BigInt.
const EPOCH_DIFF_MS = 11644473600000;
const fromChromeTime = (t) => (typeof t === 'bigint' ? Number(t / 1000n) : Math.round(Number(t) / 1000)) - EPOCH_DIFF_MS;
const toChromeTime = (ms) => (BigInt(Math.round(ms)) + BigInt(EPOCH_DIFF_MS)) * 1000n;

function readBookmarks(profile) {
  const file = path.join(profile, 'Bookmarks');
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'url' && node.url) {
      let time = Date.now();
      try { if (node.date_added) time = fromChromeTime(BigInt(node.date_added)); } catch { /* keep now */ }
      out.push({ url: node.url, title: node.name || node.url, time });
    }
    for (const child of node.children || []) walk(child);
  };
  for (const root of Object.values(data.roots || {})) walk(root);
  return out;
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

function importFrom(id, store, { bookmarks = true, history = true } = {}) {
  const browser = BROWSERS.find((b) => b.id === id);
  const profile = browser && profileDir(browser);
  if (!profile) return { ok: false, error: 'That browser was not found on this Mac.' };
  const res = { ok: true, browser: browser.name, bookmarks: 0, history: 0 };
  try {
    if (bookmarks) res.bookmarks = store.importBookmarks(readBookmarks(profile));
    if (history) res.history = store.importHistory(readHistory(profile));
  } catch (err) {
    return { ok: false, error: `Couldn't read ${browser.name}'s data: ${err.message}` };
  }
  return res;
}

module.exports = { detect, importFrom, readBookmarks, readHistory, fromChromeTime, toChromeTime };
