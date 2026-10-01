// Import from Safari (Mac): bookmarks (Bookmarks.plist, read with plutil) and
// history (History.db, a SQLite database). macOS protects both: Lumio needs
// Full Disk Access to read them. Without it, people can export from Safari
// instead (File > Export > Bookmarks / Passwords) and pick the files.
// Safari's passwords live in the Passwords app and can only come as a CSV export.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const safariDir = () => process.env.LUMIO_SAFARI_DIR || path.join(os.homedir(), 'Library', 'Safari');
const SAFARI_EPOCH_MS = 978307200000; // 2001-01-01

function detect() {
  if (process.platform !== 'darwin' && !process.env.LUMIO_SAFARI_DIR) return [];
  return fs.existsSync(safariDir()) ? [{ id: 'safari', name: 'Safari', kind: 'safari', passwords: false }] : [];
}

class AccessError extends Error {
  constructor() { super('Lumio needs Full Disk Access to read Safari’s bookmarks and history.'); this.code = 'needs_access'; }
}
const denied = (err) => ['EPERM', 'EACCES'].includes(err?.code) || /Operation not permitted|Permission denied/i.test(String(err?.stderr || err?.message || ''));

function readBookmarks() {
  const file = path.join(safariDir(), 'Bookmarks.plist');
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    fs.accessSync(file, fs.constants.R_OK);
    data = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    if (denied(err)) throw new AccessError();
    throw err;
  }
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.Title === 'com.apple.ReadingList') return; // the reading list isn't bookmarks
    if (node.WebBookmarkType === 'WebBookmarkTypeLeaf' && /^https?:/i.test(node.URLString || '')) {
      out.push({ url: node.URLString, title: node.URIDictionary?.title || node.URLString, time: Date.now() });
    }
    for (const child of node.Children || []) walk(child);
  };
  walk(data);
  return out;
}

function readHistory({ days = 90, limit = 20000 } = {}) {
  const file = path.join(safariDir(), 'History.db');
  if (!fs.existsSync(file)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-import-'));
  try {
    try {
      for (const f of ['History.db', 'History.db-wal', 'History.db-shm']) {
        if (fs.existsSync(path.join(safariDir(), f))) fs.copyFileSync(path.join(safariDir(), f), path.join(tmp, f));
      }
    } catch (err) {
      if (denied(err)) throw new AccessError();
      throw err;
    }
    const db = new DatabaseSync(path.join(tmp, 'History.db'), { readOnly: true });
    const since = (Date.now() - days * 86400000 - SAFARI_EPOCH_MS) / 1000;
    const rows = db.prepare(
      `SELECT i.url AS url, v.title AS title, v.visit_time AS t
         FROM history_visits v JOIN history_items i ON i.id = v.history_item
        WHERE v.visit_time > ? AND (i.url LIKE 'http://%' OR i.url LIKE 'https://%')
        ORDER BY v.visit_time DESC LIMIT ?`,
    ).all(since, limit);
    db.close();
    return rows.map((r) => ({ url: r.url, title: r.title || r.url, time: Math.round(r.t * 1000 + SAFARI_EPOCH_MS) }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function importFrom(store, { bookmarks = true, history = true } = {}) {
  const res = { ok: true, browser: 'Safari', bookmarks: 0, history: 0, passwords: null };
  try {
    if (bookmarks) res.bookmarks = store.importBookmarks(readBookmarks());
    if (history) res.history = store.importHistory(readHistory());
  } catch (err) {
    if (err.code === 'needs_access') return { ok: false, needsAccess: true, error: err.message };
    return { ok: false, error: `Couldn't read Safari's data: ${err.message}` };
  }
  return res;
}

module.exports = { detect, importFrom, readBookmarks, readHistory };
