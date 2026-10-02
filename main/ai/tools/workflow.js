// Workflows the AI can save for the person ("save this as a workflow") and
// read when asked to run one. Saving asks first in Ask mode, like other
// lasting changes.
const tools = [
  {
    name: 'save_workflow',
    risk: 'browser',
    icon: 'workflow',
    description: 'Save a reusable workflow the user can run again with one click: when they ask to save what you just did (or a task they describe) as a workflow. Write the instructions for your future self as clear, general steps (pages to open, what to look for, what to report), not a log of this run, and put things that change each time in curly braces, like {item} or {date}. Saving a name that already exists updates it.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 60, description: 'Short name, like "Weekly expense report"' },
        instructions: { type: 'string', maxLength: 6000, description: 'The steps, with {blanks} for what changes each run' },
        start_url: { type: 'string', maxLength: 2000, description: 'The page to start on (optional)' },
        description: { type: 'string', maxLength: 200, description: 'One line for the list (optional)' },
        inputs: {
          type: 'array',
          maxItems: 6,
          description: 'A friendly label for each {blank} (optional)',
          items: { type: 'object', properties: { name: { type: 'string', maxLength: 30 }, label: { type: 'string', maxLength: 60 } }, required: ['name', 'label'], additionalProperties: false },
        },
      },
      required: ['title', 'instructions'],
      additionalProperties: false,
    },
    label: (a) => `Saving workflow “${String(a.title || '').slice(0, 50)}”`,
    detail: (a) => `Save the workflow “${String(a.title || '').slice(0, 60)}”:\n${String(a.instructions || '').slice(0, 600)}`,
    run(a, ctx) {
      if (!ctx.workflows) throw new Error('Workflows aren’t available in this window.');
      const w = ctx.workflows.add(a);
      const blanks = w.inputs.length ? ` It asks for ${w.inputs.map((i) => i.label).join(', ')} each time.` : '';
      return { text: `Saved the workflow “${w.title}” (id ${w.id}).${blanks} The user runs it by typing / in the chat box, from the new tab page, or on a schedule; they can edit it in Settings › Workflows.`, summary: 'Saved' };
    },
  },
  {
    name: 'list_workflows',
    risk: 'read',
    icon: 'workflow',
    description: 'List the user’s saved workflows with their instructions, to follow one when they ask you to run it by name.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    label: () => 'Checking your workflows',
    run(_a, ctx) {
      const list = ctx.workflows?.list() || [];
      if (!list.length) return { text: 'No saved workflows.' };
      return {
        text: list.map((w) => `- “${w.title}” (id ${w.id})${w.startUrl ? `, starts at ${w.startUrl}` : ''}${w.inputs.length ? `, blanks: ${w.inputs.map((i) => `{${i.name}}`).join(' ')}` : ''}\n  ${w.instructions.slice(0, 1500).replace(/\n/g, '\n  ')}`).join('\n'),
        summary: `${list.length} workflow${list.length === 1 ? '' : 's'}`,
      };
    },
  },
];

module.exports = { tools, NAMES: new Set(tools.map((t) => t.name)) };
