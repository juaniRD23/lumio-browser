// Projects: folders for Lumio chats, with instructions Lumio follows in every
// chat inside ("We're planning Mom's 50th: budget $800, Miami, mid-June").
// Shown in the sidebar; chats carry a projectId. Kept in projects.json and
// synced across devices (main/sync).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PROJECTS = 50;

function clean(spec) {
  const name = String(spec?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw new Error('Give the project a name.');
  return { name, instructions: String(spec?.instructions ?? '').trim().slice(0, 4000) };
}

class Projects {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'projects.json');
    this.now = now;
    this.listeners = new Set();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(data.projects) ? data.projects.filter((p) => p && p.id) : [];
    } catch {
      this.items = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ projects: this.items }, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch {}
    for (const fn of this.listeners) fn();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  list() { return [...this.items].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id) { return this.items.find((p) => p.id === id) || null; }

  add(spec) {
    if (this.items.length >= MAX_PROJECTS) throw new Error(`You can have up to ${MAX_PROJECTS} projects.`);
    const now = this.now();
    const p = { id: crypto.randomUUID(), ...clean(spec), createdAt: now, updatedAt: now };
    this.items.push(p);
    this.save();
    return p;
  }

  update(id, patch = {}) {
    const p = this.get(id);
    if (!p) throw new Error('That project doesn’t exist anymore.');
    Object.assign(p, clean({ ...p, ...patch }), { updatedAt: this.now() });
    this.save();
    return p;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  // Sync (main/sync): every project as a record; applying another device's.
  records() { return Object.fromEntries(this.items.map((p) => [p.id, p])); }
  applyRemote(id, p) {
    const i = this.items.findIndex((x) => x.id === id);
    if (!p) { if (i >= 0) this.items.splice(i, 1); } else if (i >= 0) this.items[i] = { ...p, id }; else this.items.push({ ...p, id });
  }
}

module.exports = { Projects, MAX_PROJECTS };
