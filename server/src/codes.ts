// Plan codes: the owner makes one-time codes on the /admin page ("GO-7KQ4-…"),
// and whoever enters one on their account page or in Lumio Browser's Settings
// gets that plan for 30 days, without paying. Each code works once. Codes are
// stored by a hash (with only their last 4 characters to tell them apart), so
// the list on /admin can't be used to redeem them.
import type { Plan } from './agent.ts';
import type { User } from './auth.ts';
import { PAID } from './billing.ts';
import { PLANS, planName } from './usage.ts';
import { type Env, json, sha256 } from './util.ts';

export const CODE_DAYS = 30;
const DAY = 24 * 3600_000;
// No 0/O, 1/I/L: easy to read out and type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIX: Record<string, Plan> = { GO: 'go', PLUS: 'plus', PRO: 'pro', MAX: 'max' };

// "plus" → "PLUS-7KQ4-M2XD-9WTA" (12 random characters, about 59 bits).
export function makeCode(plan: Plan) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${plan.toUpperCase()}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

// What people type: any case, spaces or no dashes.
export function normalizeCode(input: unknown) {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = Object.keys(PREFIX).sort((a, b) => b.length - a.length).find((p) => raw.startsWith(p));
  if (!prefix) return null;
  const rest = raw.slice(prefix.length);
  if (rest.length !== 12 || [...rest].some((c) => !ALPHABET.includes(c))) return null;
  return `${prefix}-${rest.slice(0, 4)}-${rest.slice(4, 8)}-${rest.slice(8)}`;
}

const hashOf = (code: string) => sha256(`lumio-plan-code|${code}`);

// A code's month ran out: back to Free. Called whenever an account is loaded.
export async function expireCodePlan(env: Env, user: User, now = Date.now()) {
  if (user.plan_status !== 'code' || (user.plan_renews_at ?? 0) > now) return user;
  await env.DB.prepare("UPDATE users SET plan = 'free', plan_status = NULL, plan_renews_at = NULL WHERE id = ?1 AND plan_status = 'code'").bind(user.id).run();
  return { ...user, plan: 'free' as Plan, plan_status: null, plan_renews_at: null };
}

// POST /api/billing/redeem { code }
export async function redeemCode(request: Request, env: Env, user: User, now = Date.now()) {
  const body = await request.json<{ code?: string }>().catch(() => ({ code: undefined }));
  const code = normalizeCode(body.code);
  const invalid = () => json({ error: 'That code isn’t valid, or it was already used.', code: 'invalid_code' }, 400);
  if (!code) return invalid();
  if (user.subscription_id && ['active', 'trialing', 'past_due', 'canceling'].includes(user.plan_status || '')) {
    return json({ error: `You already pay for Lumio ${planName(user.plan)}. Cancel it first if you’d like to use a code instead.`, code: 'already_subscribed' }, 409);
  }
  const hash = await hashOf(code);
  const row = await env.DB.prepare('SELECT plan FROM plan_codes WHERE code_hash = ?1 AND redeemed_by IS NULL').bind(hash).first<{ plan: Plan }>();
  if (!row || !PAID.includes(row.plan)) return invalid();
  // Another code for the same plan adds a month; otherwise the month starts now.
  const from = user.plan_status === 'code' && user.plan === row.plan && (user.plan_renews_at ?? 0) > now ? user.plan_renews_at! : now;
  const until = from + CODE_DAYS * DAY;
  // Only one account can claim it, even if two try at the same moment.
  const claimed = await env.DB.prepare('UPDATE plan_codes SET redeemed_by = ?2, redeemed_at = ?3, plan_until = ?4 WHERE code_hash = ?1 AND redeemed_by IS NULL')
    .bind(hash, user.id, now, until).run();
  if (!claimed.meta.changes) return invalid();
  await env.DB.prepare("UPDATE users SET plan = ?2, plan_status = 'code', plan_renews_at = ?3 WHERE id = ?1").bind(user.id, row.plan, until).run();
  return json({ ok: true, plan: row.plan, planName: planName(row.plan), until });
}

// ---------------------------------------------------------------- the owner (/admin)
const ownerOnly = (user: User) => (user.role === 'owner' ? null : json({ error: 'Not found.', code: 'not_found' }, 404));

// POST /api/admin/codes { plan, count }: new codes, shown this once.
export async function createCodes(request: Request, env: Env, user: User, now = Date.now()) {
  const denied = ownerOnly(user);
  if (denied) return denied;
  const body = await request.json<{ plan?: string; count?: number }>().catch(() => ({ plan: undefined, count: undefined }));
  const plan = body.plan as Plan;
  if (!PAID.includes(plan)) return json({ error: `Choose ${PAID.map((p) => PLANS[p].name).join(', ')}.`, code: 'invalid_plan' }, 400);
  const count = Math.max(1, Math.min(20, Math.floor(Number(body.count) || 1)));
  const codes = Array.from({ length: count }, () => makeCode(plan));
  await env.DB.batch(await Promise.all(codes.map(async (c) => env.DB.prepare('INSERT INTO plan_codes (code_hash, plan, hint, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await hashOf(c), plan, c.slice(-4), now))));
  return json({ codes, plan, planName: planName(plan), days: CODE_DAYS });
}

// GET /api/admin/codes: the latest 100, used or not (never the codes themselves).
export async function listCodes(env: Env, user: User) {
  const denied = ownerOnly(user);
  if (denied) return denied;
  const { results } = await env.DB.prepare(`SELECT c.plan, c.hint, c.created_at, c.redeemed_at, c.plan_until, u.email
    FROM plan_codes c LEFT JOIN users u ON u.id = c.redeemed_by ORDER BY c.created_at DESC LIMIT 100`).all<{ plan: Plan; hint: string; created_at: number; redeemed_at: number | null; plan_until: number | null; email: string | null }>();
  return json({ codes: results.map((r) => ({ plan: r.plan, planName: planName(r.plan), hint: r.hint, createdAt: r.created_at, usedAt: r.redeemed_at, usedBy: r.email, until: r.plan_until })) });
}

// Used by tests and the one-off script that seeds codes straight into D1.
export { hashOf as codeHash };
