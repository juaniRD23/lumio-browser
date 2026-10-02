// Scheduled tasks the AI can set up for the person ("every morning at 8,
// summarize the news"). Creating one asks first in Ask mode, like other
// browser actions, because it will act later on its own.
const { REPEATS, DAYS } = require('../../schedules');

const tools = [
  {
    name: 'schedule_task',
    risk: 'browser',
    icon: 'clock',
    description: 'Schedule a task for Lumio to do later on its own, once or repeating (hourly, daily, weekdays, weekly), in the user\'s local time. Only when the user asks for something to happen later or regularly. Write the prompt as a complete instruction for your future self, since the chat history won\'t be there.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 80, description: 'Short name, like "Morning news"' },
        prompt: { type: 'string', maxLength: 4000, description: 'What to do when it runs, as a complete instruction' },
        repeat: { type: 'string', enum: REPEATS },
        time: { type: 'string', maxLength: 10, description: 'Local time, like "08:00" or "18:30" (for hourly, the minutes count)' },
        weekday: { type: 'string', enum: DAYS, description: 'For weekly' },
        date: { type: 'string', maxLength: 10, description: 'For once: YYYY-MM-DD (default: the next time that clock time comes)' },
      },
      required: ['title', 'prompt', 'repeat', 'time'],
      additionalProperties: false,
    },
    label: (a) => `Scheduling “${String(a.title || 'a task').slice(0, 60)}”`,
    detail: (a) => `Schedule “${String(a.title || '').slice(0, 60)}” (${a.repeat} at ${a.time}): ${String(a.prompt || '').slice(0, 200)}`,
    run(a, ctx) {
      if (!ctx.schedules) throw new Error('Scheduled tasks aren’t available in this window.');
      const t = ctx.schedules.add(a);
      return { text: `Scheduled “${t.title}” (id ${t.id}): ${t.when}. Next run: ${new Date(t.nextRun).toString()}. The user can see and change it in Settings › Scheduled tasks.`, summary: t.when };
    },
  },
  {
    name: 'list_scheduled_tasks',
    risk: 'read',
    icon: 'clock',
    description: 'List the user\'s scheduled tasks with their ids, times and what they do.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Checking scheduled tasks',
    run(_a, ctx) {
      const list = ctx.schedules?.list() || [];
      if (!list.length) return { text: 'No scheduled tasks.' };
      return {
        text: list.map((t) => `- ${t.id}: “${t.title}” — ${t.when}${t.paused ? ' (paused)' : t.done ? ' (done)' : ''}${t.nextRun ? `, next ${new Date(t.nextRun).toString()}` : ''}\n  Does: ${t.prompt.slice(0, 300)}`).join('\n'),
        summary: `${list.length} task${list.length === 1 ? '' : 's'}`,
      };
    },
  },
  {
    name: 'cancel_scheduled_task',
    risk: 'browser',
    icon: 'trash',
    description: 'Delete one of the user\'s scheduled tasks by id (from list_scheduled_tasks).',
    parameters: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'], additionalProperties: false },
    label: (a, ctx) => `Deleting “${ctx.schedules?.get(a.id)?.title || 'scheduled task'}”`,
    run(a, ctx) {
      const t = ctx.schedules?.get(a.id);
      if (!t) throw new Error('No scheduled task with that id. Call list_scheduled_tasks.');
      ctx.schedules.remove(a.id);
      return { text: `Deleted “${t.title}”.` };
    },
  },
];

module.exports = { tools, NAMES: new Set(tools.map((t) => t.name)) };
