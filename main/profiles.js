// Profiles: separate people (or work and personal) on one computer, like
// Chrome's. Each profile has its own tab session (cookies, logins, cache), its
// own folder for history, bookmarks, settings, passwords and chats, its own
// Lumio account and sync. This file is the list of profiles (profiles.json in
// userData); main.js opens each profile's services when it's first used.
//
// The first profile ("default") is the one every Lumio Browser had before
// profiles: its files stay right in userData and its tabs keep the
// 'persist:lumio' session, so nothing moves for people updating. Its
// settings.json also holds the app-wide settings (appearance, performance).
// Other profiles live in userData/Profiles/<id>, with 'persist:lumio-<id>'.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');

const DEFAULT_PROFILE = 'default';
// The avatar colors offered in Settings › Customize profile (pastels that read in light and dark).
const COLORS = ['#86b7ff', '#b58cff', '#7ee2a8', '#ffb86b', '#ff8fc7', '#ff7a7a', '#ffd479', '#e4e4e7'];
const THEMES = ['blue', 'purple', 'green', 'orange', 'pink', 'mono'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^p[0-9a-f]{8}$/;

const isId = (id) => id === DEFAULT_PROFILE || ID_RE.test(String(id));
const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

// "Person 2", "Person 3"…: the first number no profile is called yet.
function nextName(names) {
  const taken = new Set(names.map((n) => String(n).toLowerCase()));
  for (let n = names.length + 1; ; n++) if (!taken.has(`person ${n}`)) return `Person ${n}`;
}

// The first avatar color nobody uses yet (then they repeat).
function nextColor(used) {
  return COLORS.find((c) => !used.includes(c)) || COLORS[used.length % COLORS.length];
}

class ProfileRegistry {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
    this.file = new JsonFile(root, 'profiles.json', { profiles: [], showPicker: true, lastUsed: DEFAULT_PROFILE, lastOpen: [], trash: [] });
    const d = this.file.data;
    d.profiles = (Array.isArray(d.profiles) ? d.profiles : []).filter((p) => p && isId(p.id));
    if (!d.profiles.some((p) => p.id === DEFAULT_PROFILE)) d.profiles.unshift({ id: DEFAULT_PROFILE, created: 0 });
    if (typeof d.showPicker !== 'boolean') d.showPicker = true;
    if (!Array.isArray(d.trash)) d.trash = [];
    if (!Array.isArray(d.lastOpen)) d.lastOpen = [];
  }

  get data() { return this.file.data; }
  ids() { return this.data.profiles.map((p) => p.id); }
  get(id) { return this.data.profiles.find((p) => p.id === id) || null; }
  get count() { return this.data.profiles.length; }

  dirOf(id) { return id === DEFAULT_PROFILE ? this.root : path.join(this.root, 'Profiles', id); }
  partitionOf(id) { return id === DEFAULT_PROFILE ? 'persist:lumio' : `persist:lumio-${id}`; }
  // Where Chromium keeps a persistent session's files.
  partitionDir(id) { return path.join(this.root, 'Partitions', this.partitionOf(id).slice('persist:'.length)); }
  // Guest's files while a Guest window is open, one folder per Guest session
  // (wiped when it ends, and all of them at launch).
  get guestRoot() { return path.join(this.root, 'Guest Profile'); }
  guestDir(session) { return path.join(this.guestRoot, String(session)); }

  // ---- what the picker and menus show
  settingsOf(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'settings.json'), 'utf8')).profile || {}; } catch { return {}; }
  }
  // live: the profile's settings.profile when it's open (fresher than the file).
  describe(id, live = null) {
    const entry = this.get(id);
    if (!entry) return null;
    const p = live || this.settingsOf(id);
    const index = this.data.profiles.indexOf(entry);
    return {
      id,
      name: cleanName(p.name) || entry.accountName || entry.email || `Person ${index + 1}`,
      color: COLOR_RE.test(p.color || '') ? p.color : COLORS[0],
      theme: THEMES.includes(p.theme) ? p.theme : 'blue',
      photo: typeof p.photo === 'string' && p.photo.startsWith('data:image/') ? p.photo : null,
      email: entry.email || null,
      isDefault: id === DEFAULT_PROFILE,
    };
  }

  // The Lumio account signed in to a profile, kept for the picker (shown
  // without opening the profile).
  // Returns whether anything changed.
  remember(id, { email = null, accountName = null } = {}) {
    const entry = this.get(id);
    if (!entry || ((entry.email || null) === (email || null) && (entry.accountName || null) === (accountName || null))) return false;
    entry.email = email || undefined;
    entry.accountName = accountName || undefined;
    this.file.save();
    return true;
  }

  // ---- adding and deleting
  add({ name, color, theme } = {}) {
    const names = this.data.profiles.map((p) => this.describe(p.id).name);
    const colors = this.data.profiles.map((p) => this.describe(p.id).color);
    let id;
    do id = 'p' + crypto.randomBytes(4).toString('hex'); while (this.get(id));
    const profile = {
      name: cleanName(name) || nextName(names),
      color: COLOR_RE.test(color || '') ? color : nextColor(colors),
      photo: null,
      theme: THEMES.includes(theme) ? theme : 'blue',
    };
    const dir = this.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    // A new profile skips the first-run welcome (that's for a new install).
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ profile, onboarded: true }));
    this.data.profiles.push({ id, created: Date.now() });
    this.file.save(true);
    return this.describe(id);
  }

  // Forgets a profile and deletes its files. The open session's files may
  // still be in use, so they're deleted again at the next launch (emptyTrash).
  remove(id) {
    if (id === DEFAULT_PROFILE || !this.get(id)) return false;
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    this.data.lastOpen = this.data.lastOpen.filter((x) => x !== id);
    if (this.data.lastUsed === id) this.data.lastUsed = DEFAULT_PROFILE;
    for (const dir of [this.dirOf(id), this.partitionDir(id)]) {
      if (!this.data.trash.includes(dir)) this.data.trash.push(dir);
      this.rm(dir);
    }
    this.file.save(true);
    return true;
  }

  // Deletes what deleted profiles left behind (at launch, before any session opens).
  emptyTrash() {
    this.data.trash = this.data.trash.filter((dir) => !this.rm(dir));
    this.rm(this.guestRoot);
    this.file.save(true);
  }

  // Only ever folders inside userData's Profiles, Partitions or Guest Profile.
  rm(dir) {
    const rel = path.relative(this.root, String(dir || ''));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/^(Profiles|Partitions)[\\/][^\\/]+$|^Guest Profile([\\/][^\\/]+)?$/.test(rel)) return true; // never anything else
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
  }

  // ---- startup
  get showPicker() { return this.data.showPicker; }
  set showPicker(on) { this.data.showPicker = !!on; this.file.save(true); }
  lastUsed() { return this.get(this.data.lastUsed) ? this.data.lastUsed : DEFAULT_PROFILE; }
  setLastUsed(id) {
    if (!this.get(id) || this.data.lastUsed === id) return;
    this.data.lastUsed = id;
    this.file.save();
  }
  // The profiles that had windows open when Lumio quit (they open again).
  lastOpen() { return this.data.lastOpen.filter((id) => this.get(id)); }
  setLastOpen(ids) {
    this.data.lastOpen = ids.filter((id) => this.get(id));
    this.file.save(true);
  }
  // At launch: the picker when there are several profiles and it's on.
  wantsPicker() { return this.count >= 2 && this.showPicker; }

  flush() { if (this.file.timer) this.file.flush(); }
}

module.exports = { ProfileRegistry, DEFAULT_PROFILE, COLORS, nextName, nextColor };
