import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Schedules, normalize, nextRun, describe, parseTime, CATCH_UP } = require('../main/schedules.js');

const at = (s) => new Date(s).getTime(); // local time
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-sched-'));

test('times in either clock style', () => {
  assert.deepEqual(parseTime('8:05'), { h: 8, m: 5 });
  assert.deepEqual(parseTime('20:30'), { h: 20, m: 30 });
  assert.deepEqual(parseTime('6:30 pm'), { h: 18, m: 30 });
  assert.deepEqual(parseTime('12 am'), { h: 0, m: 0 });
  assert.equal(parseTime('25:00'), null);
  assert.equal(parseTime('noon'), null);
});

test('next run for each kind of repeat', () => {
  const wed9 = at('2026-10-07T09:00:00'); // a Wednesday
  assert.equal(nextRun({ repeat: 'daily', time: '08:00' }, wed9), at('2026-10-08T08:00:00'));
  assert.equal(nextRun({ repeat: 'daily', time: '10:00' }, wed9), at('2026-10-07T10:00:00'));
  assert.equal(nextRun({ repeat: 'hourly', time: '00:15' }, wed9), at('2026-10-07T09:15:00'));
  assert.equal(nextRun({ repeat: 'hourly', time: '00:00' }, wed9), at('2026-10-07T10:00:00'));
  const fri = at('2026-10-09T09:00:00');
  assert.equal(nextRun({ repeat: 'weekdays', time: '08:00' }, fri), at('2026-10-12T08:00:00'), 'skips the weekend');
  assert.equal(nextRun({ repeat: 'weekly', time: '07:30', weekday: 'monday' }, wed9), at('2026-10-12T07:30:00'));
  assert.equal(nextRun({ repeat: 'once', time: '08:00', date: '2026-10-08' }, wed9), at('2026-10-08T08:00:00'));
  assert.equal(nextRun({ repeat: 'once', time: '08:00', date: '2026-10-06' }, wed9), null);
});

test('checking new tasks', () => {
  const now = at('2026-10-07T09:00:00');
  assert.throws(() => normalize({ title: 'x', prompt: '', repeat: 'daily', time: '8:00' }, now), /what Lumio should do/);
  assert.throws(() => normalize({ prompt: 'x', repeat: 'daily', time: 'later' }, now), /time like/);
  assert.throws(() => normalize({ prompt: 'x', repeat: 'weekly', time: '8:00' }, now), /day of the week/);
  assert.throws(() => normalize({ prompt: 'x', repeat: 'once', time: '8:00', date: '2026-10-01' }, now), /already passed/);
  const once = normalize({ prompt: 'Check the price', repeat: 'once', time: '8:00' }, now);
  assert.equal(once.date, '2026-10-08', 'no date: the next 8:00');
  assert.equal(once.title, 'Check the price');
  assert.equal(describe({ repeat: 'weekdays', time: '08:00' }), 'Every weekday at 8:00 AM');
  assert.equal(describe({ repeat: 'weekly', time: '18:30', weekday: 'friday' }), 'Every Friday at 6:30 PM');
});

test('due tasks run once, move to their next time, and survive a restart', () => {
  const dir = tmp();
  let now = at('2026-10-07T07:59:00');
  const s = new Schedules(dir, { now: () => now });
  const t = s.add({ title: 'News', prompt: 'Summarize the news', repeat: 'daily', time: '08:00' });
  assert.equal(t.nextRun, at('2026-10-07T08:00:00'));
  assert.equal(s.due().length, 0);
  now = at('2026-10-07T08:00:10');
  assert.deepEqual(s.due().map((x) => x.id), [t.id]);
  s.started(t.id, 'chat-1');
  assert.equal(s.due().length, 0);
  assert.equal(s.get(t.id).nextRun, at('2026-10-08T08:00:00'));
  s.finished(t.id, 'done');
  const again = new Schedules(dir, { now: () => now });
  assert.equal(again.get(t.id).lastChatId, 'chat-1');
  assert.equal(again.get(t.id).lastStatus, 'done');
});

test('Run now keeps the schedule; pausing stops it', () => {
  let now = at('2026-10-07T07:00:00');
  const s = new Schedules(tmp(), { now: () => now });
  const t = s.add({ prompt: 'x', repeat: 'daily', time: '08:00' });
  s.started(t.id, 'c', { manual: true });
  assert.equal(s.get(t.id).nextRun, at('2026-10-07T08:00:00'));
  s.update(t.id, { paused: true });
  now = at('2026-10-07T08:00:30');
  assert.equal(s.due().length, 0);
  s.update(t.id, { paused: false });
  assert.equal(s.get(t.id).nextRun, at('2026-10-08T08:00:00'));
});

test('runs missed long ago are skipped, recent ones catch up', () => {
  let now = at('2026-10-07T07:00:00');
  const s = new Schedules(tmp(), { now: () => now });
  const a = s.add({ prompt: 'a', repeat: 'daily', time: '08:00' });
  const once = s.add({ prompt: 'b', repeat: 'once', time: '08:00' });
  now = at('2026-10-07T08:00:00') + CATCH_UP - 60_000;
  assert.equal(s.due().length, 2, 'missed by under 6 hours: still runs');
  now = at('2026-10-07T08:00:00') + CATCH_UP + 60_000;
  assert.equal(s.due().length, 0);
  assert.equal(s.get(a.id).nextRun, at('2026-10-08T08:00:00'));
  assert.equal(s.get(once.id).done, true);
});

test('the AI tools add, list and cancel tasks', () => {
  const { tools } = require('../main/ai/tools/schedule.js');
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const ctx = { schedules: new Schedules(tmp()) };
  const made = by.schedule_task.run({ title: 'Inbox', prompt: 'Summarize my inbox', repeat: 'weekdays', time: '08:30' }, ctx);
  assert.match(made.text, /Every weekday at 8:30 AM/);
  const id = ctx.schedules.list()[0].id;
  assert.match(by.list_scheduled_tasks.run({}, ctx).text, new RegExp(id));
  assert.match(by.cancel_scheduled_task.run({ id }, ctx).text, /Deleted “Inbox”/);
  assert.throws(() => by.cancel_scheduled_task.run({ id }, ctx), /No scheduled task/);
});
