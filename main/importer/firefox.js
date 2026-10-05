// Import bookmarks (with folders) and history from Firefox. Both live in the
// profile's places.sqlite, which Firefox keeps open and locked: we copy it
// (with its -wal journal, which holds the latest changes) and read the copy.
// Profiles are listed in profiles.ini. Firefox encrypts saved passwords with
// its own key store, so those come as a CSV export instead.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
// Tests point this at a fake Firefox folder (or at a fake Application Support
// folder, as for Chrome).
const firefoxDir = () => process.env.LUMIO_FIREFOX_DIR
  || (process.env.LUMIO_IMPORT_ROOT && path.join(process.env.LUMIO_IMPORT_ROOT, 'Firefox'))
  || (WIN ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Mozilla', 'Firefox')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Firefox')
      : path.join(os.homedir(), '.mozilla', 'firefox'));

// profiles.ini: [ProfileN] sections (Name, Path, IsRelative, Default) and,
// in newer Firefox, [Install…] sections whose Default is the one it opens.
function parseIni(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { cur = { section: sec[1] }; out.push(cur); continue; }
    const kv = /^([^=;#]+)=(.*)$/.exec(line);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  return out;
}

// Profiles with a places.sqlite, the one Firefox opens first.
function profiles() {
  const dir = firefoxDir();
  let sections;
  try { sections = parseIni(fs.readFileSync(path.join(dir, 'profiles.ini'), 'utf8')); } catch { return []; }
  const installDefaults = new Set(sections.filter((s) => /^Install/.test(s.section) && s.Default).map((s) => s.Default));
  const list = sections.filter((s) => /^Profile\d+$/.test(s.section) && s.Path).map((s) => ({
    key: s.Path,
    name: s.Name || path.basename(s.Path),
    path: s.IsRelative === '0' ? s.Path : path.join(dir, s.Path),
    rank: installDefaults.has(s.Path) ? 0 : s.Default === '1' ? 1 : 2,
  })).filter((p) => fs.existsSync(path.join(p.path, 'places.sqlite')));
  return list.sort((a, b) => a.rank - b.rank).map(({ key, name, path: p }) => ({ key, name, path: p }));
}

function detect() {
  const list = profiles();
  return list.map((p) => ({ id: list.length > 1 ? `firefox:${p.key}` : 'firefox', name: list.length > 1 ? `Firefox (${p.name})` : 'Firefox', kind: 'firefox', passwords: false }));
}

function resolve(id) {
  const [, key] = String(id).split(/:(.*)/s);
  const list = profiles();
  return key ? list.find((p) => p.key === key) || null : list[0] || null;
}

// Opens a copy of places.sqlite; fn(db) reads it.
function withPlaces(profile, fn) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-import-'));
  try {
    for (const f of ['places.sqlite', 'places.sqlite-wal']) {
      if (fs.existsSync(path.join(profile, f))) fs.copyFileSync(path.join(profile, f), path.join(tmp, f));
    }
    const db = new DatabaseSync(path.join(tmp, 'places.sqlite'));
    try { return fn(db); } finally { db.close(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Firefox's fixed folders, by their guid.
const ROOTS = { 'toolbar_____': 'bar', 'menu________': 'other', 'unfiled_____': 'other', 'mobile______': 'mobile' };
const fromFirefoxTime = (t) => (Number(t) > 0 ? Math.round(Number(t) / 1000) : Date.now()); // microseconds

// { bar, other, mobile }, with folders: the toolbar is the bar; the
// Bookmarks Menu and Other Bookmarks go in Other bookmarks.
function readBookmarks(profile) {
  const rows = withPlaces(profile, (db) => db.prepare(
    `SELECT b.id AS id, b.type AS type, b.parent AS parent, b.title AS title, b.dateAdded AS added, b.guid AS guid, p.url AS url
       FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
      ORDER BY b.parent, b.position`,
  ).all());
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.parent)) kids.set(r.parent, []); kids.get(r.parent).push(r); }
  const list = (id, depth = 0) => (depth > 40 ? [] : (kids.get(id) || []).flatMap((r) => {
    if (r.type === 2) return [{ title: r.title || 'Folder', time: fromFirefoxTime(r.added), children: list(r.id, depth + 1) }];
    // 1 is a bookmark (3, a separator, has nothing to import; place: links are saved searches).
    return r.type === 1 && /^https?:/i.test(r.url || '') ? [{ url: r.url, title: r.title || r.url, time: fromFirefoxTime(r.added) }] : [];
  }));
  const out = { bar: [], other: [], mobile: [] };
  for (const r of rows) if (ROOTS[r.guid]) out[ROOTS[r.guid]].push(...list(r.id));
  return out;
}

function readHistory(profile, { days = 90, limit = 20000 } = {}) {
  return withPlaces(profile, (db) => db.prepare(
    `SELECT p.url AS url, p.title AS title, v.visit_date AS t
       FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
      WHERE v.visit_date > ? AND (p.url LIKE 'http://%' OR p.url LIKE 'https://%')
      ORDER BY v.visit_date DESC LIMIT ?`,
  ).all((Date.now() - days * 86400000) * 1000, limit).map((r) => ({ url: r.url, title: r.title || r.url, time: fromFirefoxTime(r.t) })));
}

function importFrom(id, store, { bookmarks = true, history = true } = {}) {
  const profile = resolve(id);
  if (!profile) return { ok: false, error: 'Firefox was not found on this computer.' };
  const res = { ok: true, browser: 'Firefox', bookmarks: 0, history: 0, passwords: null };
  try {
    if (bookmarks) res.bookmarks = store.importBookmarks(readBookmarks(profile.path), { folder: 'Imported from Firefox' });
    if (history) res.history = store.importHistory(readHistory(profile.path));
  } catch (err) {
    return { ok: false, error: `Couldn't read Firefox's data (${err.message}). Close Firefox and try again.` };
  }
  return res;
}

module.exports = { detect, importFrom, profiles, readBookmarks, readHistory, parseIni };
