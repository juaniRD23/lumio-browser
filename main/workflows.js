// Saved workflows: tasks the person taught Lumio once and runs again with one
// click ("Weekly expense report", "Find me a cheaper {item}"). Each has
// instructions written for Lumio, an optional starting page, and blanks the
// person fills in when it runs, like {item}. Kept in workflows.json and synced
// across devices (main/sync).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_WORKFLOWS = 100;
const MAX_INPUTS = 6;
const BLANK = /\{([a-z][a-z0-9_ ]{0,29})\}/gi;

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The blanks used in the instructions, like {item} -> [{ name: 'item', label: 'Item' }].
function blanksIn(text) {
  const seen = new Map();
  for (const m of String(text).matchAll(BLANK)) {
    const name = m[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (!seen.has(name)) seen.set(name, { name, label: name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) });
  }
  return [...seen.values()].slice(0, MAX_INPUTS);
}

// Checks and tidies a workflow from the AI or Settings. Throws a message for
// the person (or the model) when something is off.
function normalize(spec) {
  const title = clean(spec?.title, 60);
  const instructions = String(spec?.instructions ?? '').trim().slice(0, 6000);
  if (!title) throw new Error('Give the workflow a name.');
  if (!instructions) throw new Error('Write what the workflow should do.');
  let startUrl = clean(spec?.start_url ?? spec?.startUrl, 2000);
  if (startUrl && !/^https?:\/\//i.test(startUrl)) startUrl = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(startUrl) ? `https://${startUrl}` : '';
  // Labels the AI gave for blanks win; every {blank} in the text gets one.
  const given = new Map((Array.isArray(spec?.inputs) ? spec.inputs : []).map((i) => [clean(i?.name, 30).toLowerCase().replace(/\s+/g, '_'), clean(i?.label, 60)]));
  const inputs = blanksIn(instructions).map((b) => ({ name: b.name, label: given.get(b.name) || b.label }));
  return { title, description: clean(spec?.description, 200), instructions, startUrl, inputs };
}

// The instructions with the blanks filled in. Throws when one is missing.
function fill(workflow, values = {}) {
  const missing = workflow.inputs.filter((i) => !String(values[i.name] ?? '').trim());
  if (missing.length) throw new Error(`Fill in ${missing.map((i) => i.label).join(', ')}.`);
  return workflow.instructions.replace(BLANK, (all, raw) => {
    const name = raw.trim().toLowerCase().replace(/\s+/g, '_');
    return name in values ? String(values[name]).trim().slice(0, 500) : all;
  });
}

class Workflows {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'workflows.json');
    this.now = now;
    this.listeners = new Set();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(data.workflows) ? data.workflows.filter((w) => w && w.id) : [];
    } catch {
      this.items = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ workflows: this.items }, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch {}
    for (const fn of this.listeners) fn();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  list() { return [...this.items].sort((a, b) => (b.lastRun || b.updatedAt) - (a.lastRun || a.updatedAt)); }
  get(id) { return this.items.find((w) => w.id === id) || null; }

  add(spec) {
    if (this.items.length >= MAX_WORKFLOWS) throw new Error(`You can have up to ${MAX_WORKFLOWS} workflows. Delete one first.`);
    const now = this.now();
    const w = { id: crypto.randomUUID(), ...normalize(spec), createdAt: now, updatedAt: now, runs: 0, lastRun: null };
    // Saving the same name again updates that workflow instead of making a copy.
    const same = this.items.find((x) => x.title.toLowerCase() === w.title.toLowerCase());
    if (same) return this.update(same.id, spec);
    this.items.push(w);
    this.save();
    return w;
  }

  update(id, patch = {}) {
    const w = this.get(id);
    if (!w) throw new Error('That workflow doesn’t exist anymore.');
    Object.assign(w, normalize({ ...w, ...patch, start_url: patch.start_url ?? patch.startUrl ?? w.startUrl }), { updatedAt: this.now() });
    this.save();
    return w;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((w) => w.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  ran(id) {
    const w = this.get(id);
    if (!w) return;
    w.runs = (w.runs || 0) + 1;
    w.lastRun = this.now();
    this.save();
  }

  // Sync (main/sync): every workflow as a record, and applying ones from
  // another device (null deletes).
  records() { return Object.fromEntries(this.items.map((w) => [w.id, w])); }
  applyRemote(id, w) {
    const i = this.items.findIndex((x) => x.id === id);
    if (!w) { if (i >= 0) this.items.splice(i, 1); } else if (i >= 0) this.items[i] = { ...w, id }; else this.items.push({ ...w, id });
  }
}

module.exports = { Workflows, normalize, fill, blanksIn, MAX_WORKFLOWS, MAX_INPUTS };
