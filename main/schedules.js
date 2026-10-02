// Scheduled tasks: prompts Lumio runs on its own at set times ("every weekday
// at 8:00, check my inbox and summarize it"). Kept in schedules.json; times are
// the computer's local time. main.js checks every 20 s and runs what's due in
// a window's AI panel, then shows a notification with the result.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPEATS = ['once', 'hourly', 'daily', 'weekdays', 'weekly'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MAX_TASKS = 25;
const CATCH_UP = 6 * 60 * 60 * 1000; // a run missed while Lumio was closed still happens if it was this recent

// "8:05", "08:05", "8:05 pm", "20:05" -> { h, m }
function parseTime(value) {
  const m = String(value ?? '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3] === 'pm' ? 12 : 0); }
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}
const pad = (n) => String(n).padStart(2, '0');

// Checks and tidies a task from the AI or the Settings page. Throws a message
// meant for the person (or the model) when something is off.
function normalize(spec, now = Date.now()) {
  const title = String(spec?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const prompt = String(spec?.prompt ?? '').trim().slice(0, 4000);
  if (!prompt) throw new Error('Say what Lumio should do.');
  const repeat = REPEATS.includes(spec?.repeat) ? spec.repeat : 'once';
  const time = parseTime(spec?.time ?? (repeat === 'hourly' ? '0:00' : null));
  if (!time) throw new Error('Give a time like "8:00" or "6:30 pm".');
  const task = { title: title || prompt.replace(/\s+/g, ' ').slice(0, 60), prompt, repeat, time: `${pad(time.h)}:${pad(time.m)}` };
  if (repeat === 'weekly') {
    const day = DAYS.indexOf(String(spec?.weekday ?? '').toLowerCase());
    if (day < 0) throw new Error('Choose a day of the week.');
    task.weekday = DAYS[day];
  }
  if (repeat === 'once') {
    const date = String(spec?.date ?? '').trim();
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Give the date as YYYY-MM-DD.');
      task.date = date;
    } else {
      // No date: the next time that clock time comes around.
      const d = new Date(now);
      d.setHours(time.h, time.m, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      task.date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    const at = new Date(`${task.date}T${task.time}:00`).getTime();
    if (!Number.isFinite(at)) throw new Error('That date isn’t valid.');
    if (at <= now) throw new Error('That time has already passed.');
  }
  return task;
}

// The next time the task runs after `after` (ms), or null when it won't again.
function nextRun(task, after = Date.now()) {
  const [h, m] = task.time.split(':').map(Number);
  if (task.repeat === 'once') {
    const at = new Date(`${task.date}T${task.time}:00`).getTime();
    return at > after ? at : null;
  }
  const d = new Date(after);
  if (task.repeat === 'hourly') {
    d.setMinutes(m, 0, 0);
    if (d.getTime() <= after) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    const day = d.getDay();
    const fits = task.repeat === 'daily'
      || (task.repeat === 'weekdays' && day >= 1 && day <= 5)
      || (task.repeat === 'weekly' && DAYS[day] === task.weekday);
    if (fits && d.getTime() > after) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return null;
}

// "Every weekday at 8:00 AM", for lists and the AI's replies.
function describe(task) {
  const [h, m] = task.time.split(':').map(Number);
  const clock = `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  switch (task.repeat) {
    case 'hourly': return m ? `Every hour at :${pad(m)}` : 'Every hour';
    case 'daily': return `Every day at ${clock}`;
    case 'weekdays': return `Every weekday at ${clock}`;
    case 'weekly': return `Every ${task.weekday[0].toUpperCase()}${task.weekday.slice(1)} at ${clock}`;
    default: {
      const d = new Date(`${task.date}T00:00:00`);
      return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${clock}`;
    }
  }
}

class Schedules {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'schedules.json');
    this.now = now;
    this.listeners = new Set();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      this.tasks = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ tasks: this.tasks }, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch {}
    for (const fn of this.listeners) fn();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  list() { return this.tasks.map((t) => ({ ...t, when: describe(t) })); }
  get(id) { return this.tasks.find((t) => t.id === id) || null; }

  add(spec) {
    if (this.tasks.length >= MAX_TASKS) throw new Error(`You can have up to ${MAX_TASKS} scheduled tasks. Delete one first.`);
    const now = this.now();
    const task = { id: crypto.randomUUID(), ...normalize(spec, now), paused: false, createdAt: now, lastRun: null, lastChatId: null, lastStatus: null };
    task.nextRun = nextRun(task, now);
    this.tasks.push(task);
    this.save();
    return { ...task, when: describe(task) };
  }

  update(id, patch = {}) {
    const task = this.get(id);
    if (!task) throw new Error('That scheduled task doesn’t exist anymore.');
    if ('paused' in patch) task.paused = !!patch.paused;
    if (['title', 'prompt', 'repeat', 'time', 'weekday', 'date'].some((k) => k in patch)) {
      const merged = normalize({ ...task, ...patch, ...(patch.repeat === 'once' && !patch.date ? { date: undefined } : {}) }, this.now());
      for (const k of ['weekday', 'date']) delete task[k];
      Object.assign(task, merged);
    }
    task.nextRun = task.paused ? null : nextRun(task, this.now());
    if (task.nextRun != null) delete task.done;
    this.save();
    return { ...task, when: describe(task) };
  }

  remove(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length !== before) this.save();
    return before !== this.tasks.length;
  }

  // Tasks whose time has come. Runs missed long ago (Lumio was closed) are
  // skipped to their next time instead of all firing at once.
  due() {
    const now = this.now();
    const out = [];
    let changed = false;
    for (const t of this.tasks) {
      if (t.paused || t.done) continue;
      if (t.nextRun == null) { t.nextRun = nextRun(t, now); changed = true; }
      if (t.nextRun == null || t.nextRun > now) continue;
      if (now - t.nextRun > CATCH_UP) {
        t.nextRun = nextRun(t, now);
        if (t.nextRun == null) t.done = true;
        changed = true;
        continue;
      }
      out.push(t);
    }
    if (changed) this.save();
    return out;
  }

  // Called when a run starts: moves the task to its next time (a "Run now"
  // from Settings keeps the schedule as it is).
  started(id, chatId, { manual = false } = {}) {
    const t = this.get(id);
    if (!t) return;
    const now = this.now();
    t.lastRun = now;
    t.lastChatId = chatId;
    t.lastStatus = 'running';
    if (!manual) {
      t.nextRun = nextRun(t, Math.max(now, t.nextRun || 0));
      if (t.nextRun == null) t.done = true;
    }
    this.save();
  }

  finished(id, status) {
    const t = this.get(id);
    if (!t) return;
    t.lastStatus = status;
    this.save();
  }
}

module.exports = { Schedules, normalize, nextRun, describe, parseTime, REPEATS, DAYS, MAX_TASKS, CATCH_UP };
