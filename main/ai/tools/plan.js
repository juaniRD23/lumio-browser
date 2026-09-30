// update_plan: the agent's checklist for a multi-step task. The AI panel shows
// it as the "Task progress" card above the chat box. It only records the plan
// (nothing on the page or computer changes), so it never needs approval and
// doesn't add a step chip to the chat.
const STATUSES = ['pending', 'in_progress', 'done'];
const MAX_STEPS = 12;

function normalizePlan(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('Give the plan as 1 to 12 steps.');
  if (steps.length > MAX_STEPS) throw new Error(`Keep the plan to ${MAX_STEPS} steps or fewer.`);
  const plan = steps.map((s) => {
    const title = String(s?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!title) throw new Error('Every step needs a title.');
    return { title, status: STATUSES.includes(s?.status) ? s.status : 'pending' };
  });
  if (plan.filter((s) => s.status === 'in_progress').length > 1) throw new Error('Only one step can be in progress at a time.');
  return plan;
}

const tools = [
  {
    name: 'update_plan',
    quiet: true,
    icon: 'list',
    risk: 'read',
    description: 'Show or update your step-by-step plan for the current task. The user sees it as a "Task progress" checklist. Use it for tasks with 3 or more steps: call it before you start, then again whenever a step starts or finishes. Send the whole list every time, keep exactly one step in_progress while you work, and mark every step done when you finish. Skip it for quick questions.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 100, description: 'A short step, like "Compare prices"' },
              status: { type: 'string', enum: STATUSES },
            },
            required: ['title', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    label: () => 'Updating the plan',
    run(args, ctx) {
      const plan = normalizePlan(args.steps);
      ctx.setPlan?.(plan);
      const done = plan.filter((s) => s.status === 'done').length;
      return { text: `Plan updated (${done}/${plan.length} done).` };
    },
  },
];

module.exports = { tools, normalizePlan, STATUSES, MAX_STEPS };
