// send_helpers: on High thinking effort, Lumio can split a hard, long task and
// send up to 4 helper AIs to work at the same time, each in its own new
// background tab. Each helper has a color: a dot on its tab and its row in
// the chat show what it's doing. Their reports come back to Lumio, which
// carries on. The controller runs them (AIController.runHelpers).
const COLORS = [
  { name: 'Blue', hex: '#86b7ff' },
  { name: 'Purple', hex: '#b58cff' },
  { name: 'Green', hex: '#7ee2a8' },
  { name: 'Orange', hex: '#ffb86b' },
];
const MAX_HELPERS = COLORS.length;
// A helper's safety ceiling (one that's stuck is stopped sooner): high enough
// that it doesn't quit halfway through its part.
const HELPER_STEPS = 60;
// What a helper may do, in its own tab only. No other tabs, no computer
// control, no files, no more helpers.
const HELPER_TOOLS = new Set(['web_search', 'read_url', 'read_page', 'click', 'type', 'select_option', 'scroll', 'navigate', 'go_back', 'wait']);

function cleanHelpers(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Give at least one helper a task.');
  if (list.length > MAX_HELPERS) throw new Error(`Send at most ${MAX_HELPERS} helpers.`);
  return list.map((h, i) => {
    const task = String(h?.task ?? '').trim().slice(0, 2000);
    if (!task) throw new Error(`Helper ${i + 1} needs a task.`);
    const title = String(h?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || task.slice(0, 40);
    let url = String(h?.url ?? '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(url) ? `https://${url}` : '';
    return { n: i + 1, title, task, url: url.slice(0, 2000), color: COLORS[i] };
  });
}

const tools = [
  {
    name: 'send_helpers',
    risk: 'read', // sending them changes nothing; each helper's own actions ask for approval like yours
    icon: 'helpers',
    description: 'Send up to 4 helper AIs to work at the same time, each in its own new background tab, then get their reports back. Only for hard, long tasks with parts that can be done separately, like comparing one product across several stores or checking several sources. Each helper sees only the task you give it (not this chat), so make each one complete, and give a starting URL when you know one. Helpers can read, search, click, type and scroll in their own tab; they cannot sign in, buy, send anything or use the computer.',
    parameters: {
      type: 'object',
      properties: {
        helpers: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_HELPERS,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 60, description: 'A few words, like "Best Buy price"' },
              task: { type: 'string', maxLength: 2000, description: 'The complete task for this helper' },
              url: { type: 'string', maxLength: 2000, description: 'Where to start (optional)' },
            },
            required: ['title', 'task'],
            additionalProperties: false,
          },
        },
        keep_tabs: { type: 'boolean', description: 'Leave the helpers’ tabs open afterwards (default: close them)' },
      },
      required: ['helpers'],
      additionalProperties: false,
    },
    label: (a) => {
      const n = Array.isArray(a.helpers) ? a.helpers.length : 0;
      return `Sending ${n} helper${n === 1 ? '' : 's'}`;
    },
    run(a, ctx) {
      if (!ctx.runHelpers) throw new Error('Helpers aren’t available here.');
      return ctx.runHelpers(cleanHelpers(a.helpers), { keepTabs: !!a.keep_tabs, parentId: ctx.callId });
    },
  },
];

module.exports = { tools, COLORS, MAX_HELPERS, HELPER_STEPS, HELPER_TOOLS, cleanHelpers };
