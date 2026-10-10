// update_plan: the agent's checklist for a multi-step task. The AI panel shows
// it as the "Task progress" card above the chat box. It only records the plan
// (nothing on the page or computer changes), so it never needs approval and
// doesn't add a step chip to the chat. A step it can't do without the person
// (a sign-in, an OK to pay, a decision) is "blocked", with the reason: the
// agent loop doesn't push it to keep going past one (agent.js, keep going).
const STATUSES = ['pending', 'in_progress', 'done', 'blocked'];
const MAX_STEPS = 12;
const MAX_REASON = 200;

function normalizePlan(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('Give the plan as 1 to 12 steps.');
  if (steps.length > MAX_STEPS) throw new Error(`Keep the plan to ${MAX_STEPS} steps or fewer.`);
  const plan = steps.map((s) => {
    const title = String(s?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!title) throw new Error('Every step needs a title.');
    const status = STATUSES.includes(s?.status) ? s.status : 'pending';
    const reason = status === 'blocked' ? String(s?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON) : '';
    return { title, status, ...(reason ? { reason } : {}) };
  });
  if (plan.filter((s) => s.status === 'in_progress').length > 1) throw new Error('Only one step can be in progress at a time.');
  return plan;
}

// The steps still to do (blocked ones wait for the person, so they aren't).
const unfinished = (plan) => (plan || []).filter((s) => s.status === 'pending' || s.status === 'in_progress');

const tools = [
  {
    name: 'update_plan',
    quiet: true,
    icon: 'list',
    risk: 'read',
    description: 'Show or update your step-by-step plan for the current task. The user sees it as a "Task progress" checklist. Use it for tasks with 3 or more steps: call it before you start, then again whenever a step starts or finishes. Send the whole list every time, keep exactly one step in_progress while you work, and mark every step done when you finish. If a step truly needs the user (a sign-in, an OK to pay or buy, a decision only they can make, information you can\'t find), mark it blocked with the reason and ask them exactly that. Skip it for quick questions.',
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
              reason: { type: 'string', maxLength: MAX_REASON, description: 'For a blocked step: what you need from the user' },
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
      const blocked = plan.filter((s) => s.status === 'blocked').length;
      // `plan` goes to the agent loop too (it keeps going while steps are left).
      return { text: `Plan updated (${done}/${plan.length} done${blocked ? `, ${blocked} blocked` : ''}).`, plan };
    },
  },
];

module.exports = { tools, normalizePlan, unfinished, STATUSES, MAX_STEPS };
