// Each plan's Lumio AI allowance: a weekly budget (and a 5-hour one below Pro),
// in microUSD of real model cost. Browser steps and web Chat replies share it.
import { AgentError, type Plan } from './agent.ts';
import type { Env } from './util.ts';

export const PLANS: Record<Plan, { name: string; weekly: number; price: number }> = {
  free: { name: 'Free', weekly: 0.05, price: 0 },
  go: { name: 'Go', weekly: 2, price: 9 }, // legacy; not sold
  plus: { name: 'Plus', weekly: 3.75, price: 20 },
  pro: { name: 'Pro', weekly: 13.75, price: 100 },
  max: { name: 'Max', weekly: 27.5, price: 200 },
};
export const planName = (p: Plan) => PLANS[p]?.name || 'Free';

// Price ceiling sent to OpenRouter (2x GPT-6 Luna's list price), USD per million tokens.
export const CEILING = { prompt: 0.1, completion: 0.5 };
// Holds use the ceiling; microUSD per token.
export const HOLD_RATE = { input: CEILING.prompt, output: CEILING.completion };
// When OpenRouter doesn't report a cost: list price, microUSD per token.
const LIST_RATE = { input: 0.05, output: 0.25 };

const HOUR = 3600_000;
export const WEEK = 7 * 24 * HOUR;
export const FIVE_HOURS = 5 * HOUR;

export function limits(plan: Plan) {
  const weekly = Math.floor((PLANS[plan]?.weekly ?? PLANS.free.weekly) * 1_000_000);
  return { weekly, fiveHour: plan === 'pro' || plan === 'max' ? null : Math.floor(weekly / 7) };
}

// What counts: settled cost, or the hold while a step runs.
export const SPENT = "COALESCE(SUM(CASE WHEN status='running' THEN held_microusd ELSE COALESCE(cost_microusd, held_microusd) END), 0)";

async function spent(env: Env, owner: string, since: number) {
  const row = await env.DB.prepare(`SELECT ${SPENT} AS used FROM steps WHERE owner = ?1 AND created_at >= ?2`).bind(owner, since).first<{ used: number }>();
  return row?.used ?? 0;
}

// The allowance, in the shape lumio-usa.online's /api/usage has always used.
export async function allowance(env: Env, owner: string, plan: Plan, now = Date.now()) {
  const l = limits(plan);
  const windows = [];
  if (l.fiveHour !== null) {
    const used = await spent(env, owner, now - FIVE_HOURS);
    windows.push({ id: 'fiveHour', label: '5-hour usage limit', limit: l.fiveHour, used, remaining: Math.max(0, l.fiveHour - used), resetsAt: now + FIVE_HOURS });
  }
  const used = await spent(env, owner, now - WEEK);
  windows.push({ id: 'weekly', label: 'Weekly usage limit', limit: l.weekly, used, remaining: Math.max(0, l.weekly - used), resetsAt: now + WEEK });
  const tightest = windows.reduce((a, b) => (a.remaining / a.limit <= b.remaining / b.limit ? a : b));
  return { ...tightest, plan, planName: planName(plan), windows, remaining: Math.min(...windows.map((w) => w.remaining)) };
}

export class LimitError extends AgentError {
  constructor(message: string) { super(message, 429, 'usage_limit'); }
}

// Reserves room for one model call (input + output) and returns how many
// output tokens it may use. Atomic across concurrent requests.
export async function reserve(env: Env, { key, owner, plan, requestHash, kind, inputTokens, maxOutput = 8192, minOutput = 1024, now = Date.now() }:
  { key: string; owner: string; plan: Plan; requestHash: string; kind: 'browser' | 'chat'; inputTokens: number; maxOutput?: number; minOutput?: number; now?: number }) {
  if (plan === 'free') {
    const cap = Math.floor(Number(env.FREE_DAILY_CAP_USD || '3') * 1_000_000);
    const today = await env.DB.prepare(`SELECT ${SPENT} AS used FROM steps WHERE plan = 'free' AND created_at >= ?1`).bind(now - 24 * HOUR).first<{ used: number }>();
    if ((today?.used ?? 0) >= cap) throw new LimitError('Lumio AI is at capacity for Free accounts today. Try again later, or upgrade for more.');
  }
  const left = (await allowance(env, owner, plan, now)).remaining;
  const inputHold = Math.ceil(inputTokens * HOLD_RATE.input);
  const output = Math.min(maxOutput, Math.floor((left - inputHold) / HOLD_RATE.output));
  const outOf = `You’ve used your Lumio AI allowance on the ${planName(plan)} plan for now.${plan === 'max' ? ' It refills over the week.' : ' Upgrade for more, or try again when it refills.'}`;
  if (output < minOutput) throw new LimitError(outOf);
  const held = inputHold + Math.ceil(output * HOLD_RATE.output);
  const l = limits(plan);
  const ok = await env.DB.prepare(`INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, created_at)
    SELECT ?1, ?2, ?3, ?11, ?4, 'running', ?5, ?6
    WHERE (SELECT ${SPENT} FROM steps WHERE owner = ?2 AND created_at >= ?7) + ?5 <= ?8
      AND (?9 IS NULL OR (SELECT ${SPENT} FROM steps WHERE owner = ?2 AND created_at >= ?10) + ?5 <= ?9)
    RETURNING key`).bind(key, owner, plan, requestHash, held, now, now - WEEK, l.weekly, l.fiveHour, now - FIVE_HOURS, kind).first();
  if (!ok) throw new LimitError(outOf);
  return { maxOutput: output };
}

export function costOf(usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null, inputEstimate: number) {
  if (usage && typeof usage.cost === 'number' && usage.cost >= 0) return Math.ceil(usage.cost * 1_000_000);
  return Math.ceil((usage?.prompt_tokens ?? inputEstimate) * LIST_RATE.input + (usage?.completion_tokens ?? 0) * LIST_RATE.output);
}

export async function settle(env: Env, key: string, cost: number, status: 'done' | 'failed', result: string | null = null) {
  await env.DB.prepare('UPDATE steps SET status = ?2, cost_microusd = ?3, result = ?4 WHERE key = ?1').bind(key, status, cost, result).run();
}
