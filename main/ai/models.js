// Lumio Browser's AI: one inexpensive model that supports tools and can see
// screenshots, run on the person's Lumio plan (every plan, Free included, has
// a weekly allowance). People choose how hard it thinks. The server names the
// model (GET /v1/agent); this is only the fallback until it answers.
const MODEL = { id: 'inclusionai/ling-3.0-flash-vl', name: 'Ling 3.0 Flash', maker: 'inclusionAI' };

const REASONING = [
  { id: 'low', name: 'Low', desc: 'Fastest, and uses the least of your plan' },
  { id: 'medium', name: 'Medium', desc: 'Balanced: good for most tasks' },
  { id: 'high', name: 'High', desc: 'Thinks longer on hard tasks, and uses more' },
];
const DEFAULT_REASONING = 'medium';

const findReasoning = (id) => REASONING.find((r) => r.id === id) || null;

module.exports = { MODEL, REASONING, DEFAULT_REASONING, findReasoning };
