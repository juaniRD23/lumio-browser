// Saved tab groups, like Chrome's: a copy of a tab group (name, color, its
// pages) that stays when the group is closed, shows at the left end of the
// bookmarks bar and opens again in one click. While the group is open, its
// copy follows it (a page added, a tab closed, a new name). Synced with
// Lumio Sync (main/sync/adapters.js, collection "savedGroups").
//
// Saved in userData/saved-groups.json as { groups: [...] }; a saved group is
// { id, title, color, tabs: [{ url, title }], created, updated }.
const crypto = require('crypto');
const { COLORS, cleanTitle } = require('./tab-groups');

const MAX_GROUPS = 200;
const MAX_TABS = 100;
const NEWTAB = 'lumio://newtab/';

const newId = () => 's' + crypto.randomBytes(9).toString('base64url');
// Web pages and new tabs only: a group from another device never opens
// Lumio's settings or a file on this computer.
function cleanTabs(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const url = String(t?.url ?? '').trim();
    if (!(url === NEWTAB || (/^https?:\/\//i.test(url) && url.length <= 4096))) continue;
    out.push({ url, title: cleanTitle(t.title).slice(0, 300) || url });
    if (out.length >= MAX_TABS) break;
  }
  return out;
}

class SavedGroups {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    if (!Array.isArray(file.data?.groups)) file.data = { groups: [] };
    this.listeners = new Set();
  }

  get groups() { return this.file.data.groups; }
  get(id) { return this.groups.find((g) => g.id === id) || null; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() {
    this.file.save();
    for (const fn of this.listeners) fn();
  }

  // Oldest first, the order they show in the bookmarks bar.
  list() { return [...this.groups].sort((a, b) => a.created - b.created).map(({ id, title, color, tabs }) => ({ id, title, color, tabs })); }

  // A copy of an open group: { title, color, tabs }. Returns its id, or null
  // when there's nothing to save.
  save({ title, color, tabs }) {
    const list = cleanTabs(tabs);
    if (!list.length || this.groups.length >= MAX_GROUPS) return null;
    const now = this.now();
    const g = { id: newId(), title: cleanTitle(title), color: COLORS.includes(color) ? color : 'grey', tabs: list, created: now, updated: now };
    this.groups.push(g);
    this.changed();
    return g.id;
  }

  // The open group changed: its copy follows. Nothing is written when
  // nothing changed (this runs on every change to the window's tabs).
  update(id, { title, color, tabs }) {
    const g = this.get(id);
    if (!g) return false;
    const next = {
      title: title === undefined ? g.title : cleanTitle(title),
      color: COLORS.includes(color) ? color : g.color,
      tabs: tabs === undefined ? g.tabs : cleanTabs(tabs),
    };
    if (!next.tabs.length) return false; // a group whose tabs all closed keeps its last pages
    if (next.title === g.title && next.color === g.color && JSON.stringify(next.tabs) === JSON.stringify(g.tabs)) return false;
    Object.assign(g, next, { updated: this.now() });
    this.changed();
    return true;
  }

  remove(id) {
    const i = this.groups.findIndex((g) => g.id === id);
    if (i < 0) return null;
    const [g] = this.groups.splice(i, 1);
    this.changed();
    return g;
  }

  // ---- Lumio Sync
  syncEntries() {
    return this.groups.map((g) => [g.id, { title: g.title, color: g.color, tabs: g.tabs, created: g.created, updated: g.updated }]);
  }

  applySynced(changes) {
    const rejected = [];
    for (const { key, record: r } of changes) {
      const i = this.groups.findIndex((g) => g.id === key);
      if (!r) { if (i >= 0) this.groups.splice(i, 1); continue; }
      const tabs = cleanTabs(r.tabs);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || !tabs.length) { rejected.push(key); continue; }
      const fields = { title: cleanTitle(r.title), color: COLORS.includes(r.color) ? r.color : 'grey', tabs, created: Number(r.created) || this.now(), updated: Number(r.updated) || this.now() };
      if (i >= 0) Object.assign(this.groups[i], fields);
      else if (this.groups.length < MAX_GROUPS) this.groups.push({ id: key, ...fields });
    }
    this.file.save();
    for (const fn of this.listeners) fn();
    return rejected;
  }
}

module.exports = { SavedGroups, cleanTabs };
