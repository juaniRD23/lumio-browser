// What Lumio spends on AI, checked against OpenRouter's own records.
//
// verifyNow (live, right after each call): looks the call up on OpenRouter by
// its generation ID and sets the step's cost to OpenRouter's official total,
// so everyone's usage is exactly what we paid. The cost already comes from
// OpenRouter at the end of each reply; this catches the rare call where that
// number was missing or the reply broke off.
// verifySpend (every 5 minutes, from the cron trigger): the backup, for calls
// OpenRouter hadn't recorded yet during the live check.
//
// spendReport (GET /api/admin/spend, owner only): what OpenRouter charged on
// Lumio's key today, this week and this month, next to what Lumio counted,
// split by Free and paid plans and by Chat, browser and pictures.
import type { User } from './auth.ts';
import { CANCEL_REASONS } from './billing.ts';
import { GEN_ID } from './openrouter.ts';
import { PLANS, toMicro } from './usage.ts';
import { type Env, json } from './util.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function openRouter(env: Env, path: string): Promise<{ status: number; data: any }> {
  const base = (env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
    return { status: res.status, data: await res.json<any>().catch(() => null) };
  } catch {
    return { status: 0, data: null };
  }
}

// OpenRouter's total for a step's calls in microUSD, or null if any of them
// isn't recorded yet.
async function billedFor(env: Env, ids: string[]): Promise<number | null> {
  let billed = 0;
  for (const id of ids) {
    const r = await openRouter(env, `/generation?id=${encodeURIComponent(id)}`);
    const cost = r.data?.data?.total_cost;
    if (r.status !== 200 || typeof cost !== 'number' || !(cost >= 0)) return null;
    billed += toMicro(cost);
  }
  return billed;
}

async function recordBilled(env: Env, key: string, billed: number, now = Date.now()) {
  await env.DB.prepare('UPDATE steps SET cost_microusd = ?2, billed_microusd = ?2, verified_at = ?3 WHERE key = ?1').bind(key, billed, now).run();
}

// OpenRouter usually has its record a second or two after a reply ends: try
// after 1, 4 and 12 seconds (background work may run 30 seconds after the
// response). Whatever is still missing is left for the backup run.
export const liveCheck = { delays: [1_000, 3_000, 8_000] };
export async function verifyNow(env: Env, steps: { key: string; ids: string[] }[]) {
  if (!env.OPENROUTER_API_KEY) return;
  let left = steps.filter((s) => s.ids.length);
  for (const delay of liveCheck.delays) {
    if (!left.length) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const missing = [];
    for (const s of left) {
      const billed = await billedFor(env, s.ids);
      if (billed === null) missing.push(s);
      else await recordBilled(env, s.key, billed);
    }
    left = missing;
  }
}

// The backup: at most `maxLookups` OpenRouter requests per run (Workers allow
// 50 on the free plan), for calls finished over a minute ago that the live
// check couldn't match. One still missing after an hour keeps its cost.
export async function verifySpend(env: Env, now = Date.now(), maxLookups = 40) {
  if (!env.OPENROUTER_API_KEY) return { checked: 0, fixed: 0 };
  const { results } = await env.DB.prepare(`SELECT key, cost_microusd, gen_ids, created_at FROM steps
    WHERE verified_at IS NULL AND gen_ids IS NOT NULL AND status != 'running' AND created_at >= ?1 AND created_at <= ?2
    ORDER BY created_at LIMIT 100`).bind(now - 2 * DAY, now - MINUTE).all<{ key: string; cost_microusd: number | null; gen_ids: string; created_at: number }>();
  let lookups = 0;
  let checked = 0;
  let fixed = 0;
  for (const row of results) {
    let ids: string[] = [];
    try { ids = (JSON.parse(row.gen_ids) as unknown[]).filter((id): id is string => typeof id === 'string' && GEN_ID.test(id)); } catch { /* unreadable: give up below */ }
    if (lookups + ids.length > maxLookups) break;
    lookups += ids.length;
    const billed = ids.length ? await billedFor(env, ids) : null;
    if (billed !== null) {
      await recordBilled(env, row.key, billed, now);
      checked++;
      if (billed !== row.cost_microusd) fixed++;
    } else if (now - row.created_at > HOUR) {
      await env.DB.prepare('UPDATE steps SET verified_at = ?2 WHERE key = ?1').bind(row.key, now).run(); // keep the cost it had
    }
  }
  return { checked, fixed };
}

// Calendar windows in UTC, the way OpenRouter reports a key's usage
// (weeks start on Monday).
function windows(now: number) {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { today: day, week: day - ((d.getUTCDay() + 6) % 7) * DAY, month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
}

const usd = (micro: number) => Math.round(micro) / 1_000_000;

export async function spendReport(env: Env, user: User, now = Date.now()) {
  if (user.role !== 'owner') return json({ error: 'Not found.', code: 'not_found' }, 404);
  const w = windows(now);
  const counted = async (since: number) => {
    const { results } = await env.DB.prepare(`SELECT CASE WHEN plan = 'free' THEN 'free' ELSE 'paid' END AS who, kind,
      COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN status = 'running' THEN held_microusd ELSE COALESCE(cost_microusd, 0) END), 0) AS cost,
      COALESCE(SUM(CASE WHEN billed_microusd IS NOT NULL THEN 1 ELSE 0 END), 0) AS checked
      FROM steps WHERE created_at >= ?1 GROUP BY who, kind`).bind(since).all<{ who: string; kind: string; calls: number; cost: number; checked: number }>();
    const sum = (f: (r: typeof results[number]) => boolean) => usd(results.filter(f).reduce((a, r) => a + r.cost, 0));
    return {
      total: sum(() => true),
      free: sum((r) => r.who === 'free'),
      paid: sum((r) => r.who === 'paid'),
      byKind: { browser: sum((r) => r.kind === 'browser'), chat: sum((r) => r.kind === 'chat'), image: sum((r) => r.kind === 'image'), voice: sum((r) => r.kind === 'voice'), translate: sum((r) => r.kind === 'translate') },
      calls: results.reduce((a, r) => a + r.calls, 0),
      checked: results.reduce((a, r) => a + r.checked, 0),
    };
  };
  const [today, week, month] = [await counted(w.today), await counted(w.week), await counted(w.month)];

  // Lumio's OpenRouter key (everything billed to it, including anything else that uses the same key).
  const key = env.OPENROUTER_API_KEY ? await openRouter(env, '/key') : { status: 0, data: null };
  const k = key.data?.data;
  const openrouter = key.status === 200 && k ? {
    today: Number(k.usage_daily ?? 0), week: Number(k.usage_weekly ?? 0), month: Number(k.usage_monthly ?? 0), total: Number(k.usage ?? 0),
    limit: typeof k.limit === 'number' ? k.limit : null, limitRemaining: typeof k.limit_remaining === 'number' ? k.limit_remaining : null,
  } : null;

  // Who's on which plan, and what paying accounts bring in (list prices, before fees).
  const { results: plans } = await env.DB.prepare(`SELECT plan, COUNT(*) AS n,
    SUM(CASE WHEN plan != 'free' AND (plan_status IS NULL OR plan_status IN ('active', 'trialing', 'past_due')) THEN 1 ELSE 0 END) AS paying
    FROM users GROUP BY plan`).all<{ plan: string; n: number; paying: number }>();
  const people = Object.fromEntries(plans.map((p) => [p.plan, p.n]));
  const monthlyRevenue = plans.reduce((a, p) => a + p.paying * (PLANS[p.plan as keyof typeof PLANS]?.price ?? 0), 0);

  const cap = Number(env.FREE_DAILY_CAP_USD || '10');
  const free24 = await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'running' THEN held_microusd ELSE COALESCE(cost_microusd, 0) END), 0) AS used
    FROM steps WHERE plan = 'free' AND created_at >= ?1`).bind(now - DAY).first<{ used: number }>();
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM steps WHERE verified_at IS NULL AND gen_ids IS NOT NULL AND created_at >= ?1`).bind(now - 2 * DAY).first<{ n: number }>();

  // Why people cancel (from the cancel form in Settings and on /account).
  const { results: why } = await env.DB.prepare('SELECT reason, COUNT(*) AS n FROM cancellations WHERE created_at >= ?1 GROUP BY reason ORDER BY n DESC')
    .bind(now - 30 * DAY).all<{ reason: string; n: number }>();
  const { results: recent } = await env.DB.prepare('SELECT reason, comment, plan, created_at FROM cancellations ORDER BY created_at DESC LIMIT 8')
    .all<{ reason: string; comment: string | null; plan: string; created_at: number }>();
  const label = (r: string) => CANCEL_REASONS[r] || r;

  return json({
    at: now,
    openrouter,
    openrouterError: openrouter ? null : 'Couldn’t read the key’s usage from OpenRouter right now.',
    lumio: { today, week, month },
    people,
    monthlyRevenue,
    freeCap: { usedToday: usd(free24?.used ?? 0), cap },
    waitingForCheck: pending?.n ?? 0,
    cancellations: {
      last30Days: why.map((r) => ({ reason: r.reason, label: label(r.reason), n: r.n })),
      recent: recent.map((r) => ({ reason: r.reason, label: label(r.reason), comment: r.comment, plan: r.plan, at: r.created_at })),
    },
  });
}
