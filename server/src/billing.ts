// Lumio plans on Stripe. People subscribe with Stripe's payment form shown
// inside Lumio's own /checkout page (Embedded Checkout), and switch plans,
// cancel (with a reason) or resume right in Lumio (Settings in Lumio Browser,
// /account on the web) through the API below; the Billing Portal is only for
// updating the card. A signed webhook keeps each account's plan in sync. Prices are found by lookup key (set up by
// scripts/stripe-setup.mjs), so no price IDs live in config. Everything Lumio
// creates carries metadata app=lumio; other payments on the same Stripe
// account (Fifty Sites) are ignored.
import type { Plan } from './agent.ts';
import type { User } from './auth.ts';
import { PLANS, planName } from './usage.ts';
import { AgentError, type Env, json } from './util.ts';

export const PAID: Plan[] = ['plus', 'pro', 'max'];
export const LOOKUP: Record<string, Plan> = { lumio_plus_monthly: 'plus', lumio_pro_monthly: 'pro', lumio_max_monthly: 'max' };
const lookupFor = (plan: Plan) => Object.keys(LOOKUP).find((k) => LOOKUP[k] === plan)!;
// Subscription states that keep the plan (past_due: Stripe is retrying the card).
const ACTIVE = new Set(['active', 'trialing', 'past_due', 'canceling']);

// ---------------------------------------------------------------- Stripe API
function form(params: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? form(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe<T = any>(env: Env, method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new AgentError('Billing isn’t set up yet.', 503, 'billing_unavailable');
  const base = (env.STRIPE_API || 'https://api.stripe.com').replace(/\/$/, '');
  const body = form(params);
  const url = method === 'GET' && [...body].length ? `${base}${path}?${body}` : `${base}${path}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? body : undefined,
  });
  const data = await res.json<any>().catch(() => null);
  // A declined card: Stripe's own words are meant for the customer ("Your card was declined.").
  if (res.status === 402) throw new AgentError(`${data?.error?.message || 'Your card was declined.'} Nothing changed.`, 402, 'card_declined');
  if (res.status === 404 && data?.error?.code === 'resource_missing') throw new AgentError(`Stripe: ${data.error.message || 'not found'}`, 502, 'stripe_missing');
  if (!res.ok) throw new AgentError(data?.error?.message ? `Stripe: ${data.error.message}` : 'Stripe didn’t answer. Try again.', 502, 'billing_error');
  return data as T;
}

let priceCache: { at: number; ids: Record<string, string> } | null = null;
async function priceId(env: Env, plan: Plan) {
  if (!priceCache || Date.now() - priceCache.at > 10 * 60_000) {
    const res = await stripe<{ data: { id: string; lookup_key: string }[] }>(env, 'GET', '/v1/prices', { lookup_keys: Object.keys(LOOKUP), active: true });
    priceCache = { at: Date.now(), ids: Object.fromEntries(res.data.map((p) => [p.lookup_key, p.id])) };
  }
  const id = priceCache.ids[lookupFor(plan)];
  if (!id) throw new AgentError('That plan isn’t available yet.', 503, 'billing_unavailable');
  return id;
}

// Lumio's own billing-portal settings (tagged app=lumio by the setup script),
// so the Stripe account's default portal (Fifty Sites) is left alone.
let portalCache: { at: number; id: string | null } | null = null;
async function portalConfig(env: Env) {
  if (!portalCache || Date.now() - portalCache.at > 10 * 60_000) {
    const res = await stripe<{ data: { id: string; metadata?: Record<string, string> }[] }>(env, 'GET', '/v1/billing_portal/configurations', { active: true, limit: 100 });
    portalCache = { at: Date.now(), id: res.data.find((c) => c.metadata?.app === 'lumio')?.id || null };
  }
  return portalCache.id || undefined;
}

async function customerFor(env: Env, user: User) {
  if (user.stripe_customer_id) {
    // One made in Stripe's test mode doesn't exist with the live key (nor a deleted one): make a new one.
    const found = await stripe<{ id: string; deleted?: boolean }>(env, 'GET', `/v1/customers/${encodeURIComponent(user.stripe_customer_id)}`)
      .catch((e) => { if (e?.code === 'stripe_missing') return null; throw e; });
    if (found && !found.deleted) return found.id;
  }
  const c = await stripe<{ id: string }>(env, 'POST', '/v1/customers', {
    email: user.email, name: user.name || undefined, metadata: { app: 'lumio', user_id: user.id },
  });
  await env.DB.prepare('UPDATE users SET stripe_customer_id = ?2 WHERE id = ?1').bind(user.id, c.id).run();
  return c.id;
}

// ---------------------------------------------------------------- routes
const subscribed = (user: User) => !!user.subscription_id && ACTIVE.has(user.plan_status || '');

export async function checkout(request: Request, env: Env, user: User) {
  const { plan, embedded, app } = await request.json<{ plan?: string; embedded?: boolean; app?: boolean }>().catch(() => ({ plan: undefined, embedded: false, app: false }));
  if (!PAID.includes(plan as Plan)) return json({ error: 'Choose Plus, Pro or Max.', code: 'invalid_plan' }, 400);
  const origin = new URL(request.url).origin;
  // Lumio's own payment page: the subscriber switches plans instead.
  if (embedded && subscribed(user)) return json({ error: `You’re already on Lumio ${planName(user.plan)}. Switch plans in Settings or on your account page.`, code: 'already_subscribed' }, 409);
  const customer = await customerFor(env, user);
  // Stripe's payment form inside Lumio's /checkout page (needs the publishable key).
  if (embedded && env.STRIPE_PUBLISHABLE_KEY) {
    const session = await stripe<{ client_secret: string }>(env, 'POST', '/v1/checkout/sessions', {
      ui_mode: 'embedded',
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      line_items: [{ price: await priceId(env, plan as Plan), quantity: 1 }],
      allow_promotion_codes: true,
      return_url: `${origin}/checkout?session_id={CHECKOUT_SESSION_ID}${app ? '&app=1' : ''}`,
      metadata: { app: 'lumio', user_id: user.id, plan },
      subscription_data: { metadata: { app: 'lumio', user_id: user.id } },
    });
    return json({ clientSecret: session.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY });
  }
  // Older pages: already subscribed, switching happens in the billing portal.
  if (subscribed(user)) {
    const portal = await stripe<{ url: string }>(env, 'POST', '/v1/billing_portal/sessions', {
      customer, return_url: `${origin}/account`, configuration: await portalConfig(env),
      flow_data: { type: 'subscription_update', subscription_update: { subscription: user.subscription_id }, after_completion: { type: 'redirect', redirect: { return_url: `${origin}/account?changed=1` } } },
    });
    return json({ url: portal.url });
  }
  const session = await stripe<{ url: string }>(env, 'POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    line_items: [{ price: await priceId(env, plan as Plan), quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${origin}/account?upgraded=1`,
    cancel_url: `${origin}/account#plans`,
    metadata: { app: 'lumio', user_id: user.id, plan },
    subscription_data: { metadata: { app: 'lumio', user_id: user.id } },
  });
  return json({ url: session.url });
}

// After Lumio's payment page: did it go through? Sets the plan right away
// instead of waiting for the webhook.
export async function checkoutStatus(request: Request, env: Env, user: User) {
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(id)) return json({ error: 'Unknown checkout.', code: 'invalid_request' }, 400);
  const session = await stripe<{ status: string; subscription?: string | null; metadata?: Record<string, string> }>(env, 'GET', `/v1/checkout/sessions/${id}`);
  if (session.metadata?.app !== 'lumio' || session.metadata?.user_id !== user.id) return json({ error: 'Unknown checkout.', code: 'not_found' }, 404);
  let plan: Plan | string = user.plan;
  if (session.status === 'complete' && session.subscription) plan = await applySubscription(env, await stripe<Sub>(env, 'GET', `/v1/subscriptions/${session.subscription}`));
  return json({ status: session.status, plan, planName: planName(plan as Plan) });
}

// Why people cancel: Stripe's cancellation feedback values, in Lumio's words.
export const CANCEL_REASONS: Record<string, string> = {
  too_expensive: 'It costs too much',
  unused: 'I don’t use it enough',
  missing_features: 'It’s missing something I need',
  low_quality: 'Lumio AI’s answers or actions weren’t good enough',
  too_complex: 'It’s hard to use',
  switched_service: 'I’m switching to another app',
  customer_service: 'I had a billing or support problem',
  other: 'Something else',
};

const PUBLIC_PAID = () => PAID.map((id) => ({ id, name: PLANS[id].name, price: PLANS[id].price }));
type FullSub = Sub & { default_payment_method?: { card?: { brand: string; last4: string; exp_month: number; exp_year: number } } | null;
  customer?: any; items: { data: { id: string; price: { id: string; lookup_key?: string | null }; current_period_end?: number }[] } };

async function liveSubscription(env: Env, user: User) {
  return stripe<FullSub>(env, 'GET', `/v1/subscriptions/${user.subscription_id}`, { expand: ['default_payment_method', 'customer.invoice_settings.default_payment_method'] });
}

// GET /api/billing/subscription: the plan, its subscription (if any) and what can be done with it.
export async function subscription(env: Env, user: User) {
  const base = { plan: user.plan, planName: planName(user.plan), plans: PUBLIC_PAID(), reasons: Object.entries(CANCEL_REASONS).map(([id, label]) => ({ id, label })) };
  if (!subscribed(user)) return json({ ...base, subscription: null });
  const sub = await liveSubscription(env, user);
  const applied = await applySubscription(env, sub); // keeps the account in step if a webhook was missed
  const plan: Plan = (['free', ...PAID] as string[]).includes(applied) ? (applied as Plan) : user.plan;
  if (!ACTIVE.has(sub.status)) return json({ ...base, plan, planName: planName(plan), subscription: null });
  const item = sub.items.data[0];
  const pm = sub.default_payment_method || sub.customer?.invoice_settings?.default_payment_method;
  return json({
    ...base,
    plan,
    planName: planName(plan),
    subscription: {
      status: sub.status,
      canceling: !!sub.cancel_at_period_end,
      periodEnd: ((item?.current_period_end ?? sub.current_period_end) || 0) * 1000 || null,
      price: PLANS[plan]?.price ?? null,
      card: pm?.card ? { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year } : null,
    },
  });
}

// POST /api/billing/change { plan }: switch in place. Upgrades charge the
// difference for the rest of the period right away (and fail cleanly if the
// card is declined); downgrades credit the unused part to the next bill.
// Switching also undoes a pending cancellation.
export async function changePlan(request: Request, env: Env, user: User) {
  const { plan } = await request.json<{ plan?: string }>().catch(() => ({ plan: undefined }));
  if (!PAID.includes(plan as Plan)) return json({ error: 'Choose Plus, Pro or Max.', code: 'invalid_plan' }, 400);
  if (!subscribed(user)) return json({ error: 'You don’t have a plan to switch yet. Choose one to subscribe.', code: 'no_subscription' }, 400);
  const sub = await liveSubscription(env, user);
  const item = sub.items.data[0];
  const from = LOOKUP[item.price.lookup_key || ''] || user.plan;
  if (from === plan && !sub.cancel_at_period_end) return json({ error: `You’re already on Lumio ${planName(plan as Plan)}.`, code: 'same_plan' }, 400);
  const up = PLANS[plan as Plan].price > (PLANS[from as Plan]?.price ?? 0);
  const updated = await stripe<Sub>(env, 'POST', `/v1/subscriptions/${sub.id}`, {
    ...(from === plan ? {} : {
      items: [{ id: item.id, price: await priceId(env, plan as Plan) }],
      proration_behavior: up ? 'always_invoice' : 'create_prorations',
      ...(up ? { payment_behavior: 'error_if_incomplete' } : {}),
    }),
    cancel_at_period_end: false,
  });
  return json({ ok: true, plan: await applySubscription(env, updated) });
}

// POST /api/billing/cancel { reason, comment }: ends the plan when the paid
// period runs out (Free after that). The reason goes to Stripe and to Lumio's
// own list on the owner's Spend page.
export async function cancelPlan(request: Request, env: Env, user: User) {
  const body = await request.json<{ reason?: string; comment?: string }>().catch(() => null);
  const reason = String(body?.reason || '');
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 1000) : '';
  if (!(reason in CANCEL_REASONS)) return json({ error: 'Choose why you’re canceling.', code: 'invalid_reason' }, 400);
  if (!subscribed(user)) return json({ error: 'You don’t have a plan to cancel.', code: 'no_subscription' }, 400);
  const updated = await stripe<Sub>(env, 'POST', `/v1/subscriptions/${user.subscription_id}`, {
    cancel_at_period_end: true,
    cancellation_details: { feedback: reason, ...(comment ? { comment } : {}) },
  });
  await env.DB.prepare('INSERT INTO cancellations (user_id, plan, reason, comment, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(user.id, user.plan, reason, comment || null, Date.now()).run();
  await applySubscription(env, updated);
  const end = (updated.items?.data?.[0]?.current_period_end ?? updated.current_period_end ?? 0) * 1000 || null;
  return json({ ok: true, endsAt: end });
}

// POST /api/billing/resume: keep the plan after all.
export async function resumePlan(env: Env, user: User) {
  if (!subscribed(user)) return json({ error: 'You don’t have a plan to resume.', code: 'no_subscription' }, 400);
  const updated = await stripe<Sub>(env, 'POST', `/v1/subscriptions/${user.subscription_id}`, { cancel_at_period_end: false });
  return json({ ok: true, plan: await applySubscription(env, updated) });
}

export async function portal(request: Request, env: Env, user: User) {
  if (!user.stripe_customer_id) return json({ error: 'There’s no billing to manage yet.', code: 'no_billing' }, 400);
  const session = await stripe<{ url: string }>(env, 'POST', '/v1/billing_portal/sessions', {
    customer: user.stripe_customer_id, return_url: `${new URL(request.url).origin}/account`, configuration: await portalConfig(env),
  });
  return json({ url: session.url });
}

// ---------------------------------------------------------------- webhook
async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]. Checked in constant time, 5-minute tolerance.
export async function verifySignature(payload: string, header: string | null, secret: string, now = Date.now()) {
  if (!header) return false;
  const t = /(?:^|,)t=(\d+)/.exec(header)?.[1];
  const sigs = [...header.matchAll(/(?:^|,)v1=([a-f0-9]{64})/g)].map((m) => m[1]);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return sigs.some((s) => {
    let diff = 0;
    for (let i = 0; i < 64; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

type Sub = { id: string; customer: string; status: string; cancel_at_period_end?: boolean; metadata?: Record<string, string>; current_period_end?: number;
  items?: { data: { price: { lookup_key?: string | null }; current_period_end?: number }[] } };

// Sets the account's plan from its subscription.
async function applySubscription(env: Env, sub: Sub) {
  const userId = sub.metadata?.user_id;
  const user = userId
    ? await env.DB.prepare('SELECT id, subscription_id FROM users WHERE id = ?1').bind(userId).first<{ id: string; subscription_id: string | null }>()
    : await env.DB.prepare('SELECT id, subscription_id FROM users WHERE stripe_customer_id = ?1').bind(sub.customer).first<{ id: string; subscription_id: string | null }>();
  if (!user) return 'no_user';
  // An old subscription ending doesn't downgrade a newer one.
  if (user.subscription_id && user.subscription_id !== sub.id && !ACTIVE.has(sub.status)) return 'stale';
  const lookup = sub.items?.data?.[0]?.price?.lookup_key || '';
  const plan: Plan = ACTIVE.has(sub.status) && LOOKUP[lookup] ? LOOKUP[lookup] : 'free';
  const renews = (sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? 0) * 1000 || null;
  // "canceling": still active, ends at the period end.
  const status = sub.status === 'active' && sub.cancel_at_period_end ? 'canceling' : sub.status;
  await env.DB.prepare('UPDATE users SET plan = ?2, plan_status = ?3, subscription_id = ?4, stripe_customer_id = COALESCE(stripe_customer_id, ?5), plan_renews_at = ?6 WHERE id = ?1')
    .bind(user.id, plan, status, sub.id, sub.customer, renews).run();
  return plan;
}

export async function webhook(request: Request, env: Env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'not configured' }, 503);
  const payload = await request.text();
  if (!(await verifySignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 400);
  const event = JSON.parse(payload) as { id: string; type: string; data: { object: any } };
  const seen = await env.DB.prepare('INSERT INTO stripe_events (id, type, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING RETURNING id')
    .bind(event.id, event.type, Date.now()).first();
  if (!seen) return json({ ok: true, duplicate: true });
  const obj = event.data.object;
  const lumio = obj?.metadata?.app === 'lumio';
  let result = 'ignored';
  if (event.type === 'checkout.session.completed' && lumio && obj.mode === 'subscription' && obj.subscription) {
    const userId = obj.metadata.user_id || obj.client_reference_id;
    if (userId && obj.customer) await env.DB.prepare('UPDATE users SET stripe_customer_id = ?2 WHERE id = ?1').bind(userId, obj.customer).run();
    result = await applySubscription(env, await stripe<Sub>(env, 'GET', `/v1/subscriptions/${obj.subscription}`));
  } else if (event.type.startsWith('customer.subscription.') && lumio) {
    result = await applySubscription(env, obj as Sub);
  }
  return json({ ok: true, result });
}
