// Each plan's Lumio AI allowance: a budget for the last 7 days (rolling), in
// microUSD of real model cost. There's no shorter limit on any plan. Browser
// steps, Chat replies and generated images all share it.
import { AgentError, type Plan } from './agent.ts';
import { ceiling, type Model } from './models.ts';
import type { Env } from './util.ts';

// What a paid plan can spend on AI: its price minus 15% profit and the fees
// (Stripe card + Billing, and OpenRouter's fee on the credits that pay for the
// models), spread over the weeks in a month. That holds even for someone who
// uses all of it every week; most people use less.
export const PRICING = {
  profit: 0.15,
  stripePercent: 0.029 + 0.007, // card 2.9% + Stripe Billing 0.7%
  stripeFixed: 0.3, // per charge
  openRouterFee: 0.055, // on credit purchases
  weeksPerMonth: 365.25 / 12 / 7,
};
export function weeklyBudget(monthlyPrice: number, profit = PRICING.profit) {
  const p = PRICING;
  const forModels = (monthlyPrice * (1 - profit - p.stripePercent) - p.stripeFixed) / (1 + p.openRouterFee);
  return Math.floor((forModels / p.weeksPerMonth) * 100) / 100;
}

// Plus uses the formula above. Go is at break-even (no profit even at full use,
// a little at typical use) so it stretches as far as $10 can; Free is a taste
// that a few percent of people upgrading pays for, with a daily cap across all
// Free accounts (FREE_DAILY_CAP_USD) as the safety net. Pro and Max are set by hand above it, on
// purpose, but never at a loss: at 100% use Pro keeps ~4% ($4.36) and Max
// ~4.5% ($9.02); at typical use both keep far more.
export const PLANS: Record<Plan, { name: string; weekly: number; price: number }> = {
  free: { name: 'Free', weekly: 0.25, price: 0 }, // about 15 website tasks or 500 chats with GPT-6 Luna
  go: { name: 'Go', weekly: weeklyBudget(10, 0), price: 10 }, // $2.03: Free's models and pictures, about 8× Free's use
  plus: { name: 'Plus', weekly: weeklyBudget(20), price: 20 },
  pro: { name: 'Pro', weekly: 20, price: 100 },
  max: { name: 'Max', weekly: 40, price: 200 },
};
export const planName = (p: Plan) => PLANS[p]?.name || 'Free';

const HOUR = 3600_000;
export const WEEK = 7 * 24 * HOUR;

export function limits(plan: Plan) {
  return { weekly: Math.round((PLANS[plan]?.weekly ?? PLANS.free.weekly) * 1_000_000) }; // dollars with cents: round away float error
}

// What counts: settled cost, or the hold while a step runs.
export const SPENT = "COALESCE(SUM(CASE WHEN status='running' THEN held_microusd ELSE COALESCE(cost_microusd, held_microusd) END), 0)";

// The allowance, in the shape lumio-usa.online's /api/usage has always used,
// plus when it refills: spending ages out 7 days after it happened, so some
// comes back at `refillsAt` and all of it by `fullAt`.
export async function allowance(env: Env, owner: string, plan: Plan, now = Date.now()) {
  const l = limits(plan);
  const since = now - WEEK;
  const row = await env.DB.prepare(`SELECT ${SPENT} AS used, MIN(created_at) AS first, MAX(created_at) AS last FROM steps WHERE owner = ?1 AND created_at >= ?2 AND COALESCE(cost_microusd, held_microusd) > 0`)
    .bind(owner, since).first<{ used: number; first: number | null; last: number | null }>();
  const used = row?.used ?? 0;
  const remaining = Math.max(0, l.weekly - used);
  const window = {
    id: 'weekly', label: 'Weekly usage', limit: l.weekly, used, remaining,
    refillsAt: row?.first ? row.first + WEEK : null, fullAt: row?.last ? row.last + WEEK : null,
    resetsAt: row?.last ? row.last + WEEK : now,
  };
  return { ...window, plan, planName: planName(plan), windows: [window] };
}

export class LimitError extends AgentError {
  constructor(message: string) { super(message, 429, 'usage_limit'); }
}

function outOfAllowance(plan: Plan) {
  return new LimitError(`You’ve used your Lumio AI allowance on the ${planName(plan)} plan for now.${plan === 'max' ? ' It refills as the week goes on.' : ' Upgrade for more, or try again when it refills.'}`);
}

// Holds `held` microUSD of the allowance while a call runs. Atomic across
// concurrent requests; Free accounts also share a daily cap.
export async function hold(env: Env, { key, owner, plan, requestHash, kind, held, now = Date.now() }:
  { key: string; owner: string; plan: Plan; requestHash: string; kind: 'browser' | 'chat' | 'image' | 'voice' | 'translate'; held: number; now?: number }) {
  if (plan === 'free') {
    const cap = Math.floor(Number(env.FREE_DAILY_CAP_USD || '10') * 1_000_000);
    const today = await env.DB.prepare(`SELECT ${SPENT} AS used FROM steps WHERE plan = 'free' AND created_at >= ?1`).bind(now - 24 * HOUR).first<{ used: number }>();
    if ((today?.used ?? 0) >= cap) throw new LimitError('Lumio AI is at capacity for Free accounts today. Try again later, or upgrade for more.');
  }
  const ok = await env.DB.prepare(`INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, created_at)
    SELECT ?1, ?2, ?3, ?9, ?4, 'running', ?5, ?6
    WHERE (SELECT ${SPENT} FROM steps WHERE owner = ?2 AND created_at >= ?7) + ?5 <= ?8
    RETURNING key`).bind(key, owner, plan, requestHash, held, now, now - WEEK, limits(plan).weekly, kind).first();
  if (!ok) throw outOfAllowance(plan);
}

// Reserves room for one model call (input + output) at the model's price
// ceiling and returns how many output tokens it may use.
export async function reserve(env: Env, { key, owner, plan, requestHash, kind, inputTokens, model, maxOutput = 8192, minOutput = 1024, now = Date.now() }:
  { key: string; owner: string; plan: Plan; requestHash: string; kind: 'browser' | 'chat' | 'translate'; inputTokens: number; model: Model; maxOutput?: number; minOutput?: number; now?: number }) {
  const left = (await allowance(env, owner, plan, now)).remaining;
  const rate = ceiling(model); // USD per million tokens = microUSD per token
  const inputHold = Math.ceil(inputTokens * rate.prompt);
  const output = Math.min(maxOutput, Math.floor((left - inputHold) / rate.completion));
  if (output < minOutput) throw outOfAllowance(plan);
  await hold(env, { key, owner, plan, requestHash, kind, held: inputHold + Math.ceil(output * rate.completion), now });
  return { maxOutput: output };
}

// USD to whole microUSD, rounding up but not over float noise
// (0.000123 * 1e6 is 123.00000000000001).
export const toMicro = (usd: number) => Math.ceil(usd * 1_000_000 - 1e-6);

// What a call cost: OpenRouter's reported cost, or the model's list price.
export function costOf(usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null, inputEstimate: number, model: Model) {
  if (usage && typeof usage.cost === 'number' && usage.cost >= 0) return toMicro(usage.cost);
  return Math.ceil((usage?.prompt_tokens ?? inputEstimate) * model.price.input + (usage?.completion_tokens ?? 0) * model.price.output);
}

// `genIds` are OpenRouter's IDs for the calls, so verifySpend (spend.ts) can check the cost.
// Also keeps how long the call took (ms) and, when given, which model answered,
// so slow steps (like a voice reply taking long to start) can be found.
export async function settle(env: Env, key: string, cost: number, status: 'done' | 'failed', result: string | null = null, genIds: string[] = [], model: string | null = null) {
  await env.DB.prepare('UPDATE steps SET status = ?2, cost_microusd = ?3, result = ?4, gen_ids = ?5, ms = ?6 - created_at, model = COALESCE(?7, model) WHERE key = ?1')
    .bind(key, status, cost, result, genIds.length ? JSON.stringify(genIds) : null, Date.now(), model).run();
}
