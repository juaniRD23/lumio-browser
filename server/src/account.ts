// Deleting a Lumio account (App Store guideline 5.1.1(v): apps that make
// accounts let people delete them in the app).
//
// DELETE /api/account { confirm: true }
// The plan ends first: the Stripe customer is deleted, which cancels any
// subscription at once (so nobody keeps paying for an account that's gone);
// if Stripe can't be reached, nothing is deleted and the app says to try
// again. Then everything the account has on Lumio's server goes: sessions,
// web chats and their files (R2 too), connected apps (Google's grant is
// revoked), Lumio Sync's encrypted records, its wrapped sync key, devices and
// pairings (and the key's rate-limit records), the companion's messages and
// push subscriptions, the apps' pending sign-in hand-off codes (app_codes,
// which a password reset also ends), email sign-in codes and attempts (by its
// email), cancellation notes, and the account itself. Apple's token is revoked for accounts that used Sign in with
// Apple. AI usage records stay for the spend accounting, without the owner or
// any content (owner 'deleted'); a redeemed plan code stays used.
import { revokeApple } from './apple.ts';
import { type User, cookieName } from './auth.ts';
import { stripe } from './billing.ts';
import { revokeConnections } from './connections.ts';
import { emailHash } from './email-auth.ts';
import { type Env, fail, json } from './util.ts';

const ACTIVE = new Set(['active', 'trialing', 'past_due', 'canceling']);

export async function deleteAccount(request: Request, env: Env, user: User, ctx: ExecutionContext) {
  const b = await request.json<{ confirm?: unknown }>().catch(() => null);
  if (b?.confirm !== true) return fail('Confirm that you want to delete your account.', 400, 'confirm_required');

  // 1. End the plan.
  if (user.stripe_customer_id) {
    if (env.STRIPE_SECRET_KEY) {
      try {
        await stripe(env, 'DELETE', `/v1/customers/${encodeURIComponent(user.stripe_customer_id)}`);
      } catch (err) {
        if ((err as { code?: string })?.code !== 'stripe_missing') {
          return fail('Lumio couldn’t end your plan, so nothing was deleted. Try again in a minute.', 502, 'billing_error');
        }
      }
    } else if (user.subscription_id && ACTIVE.has(user.plan_status || '')) {
      return fail('Lumio couldn’t end your plan, so nothing was deleted. Try again later.', 503, 'billing_unavailable');
    }
  }

  // 2. Tell Apple and Google (best effort, after answering).
  ctx.waitUntil(Promise.all([
    revokeApple(env, user).catch(() => {}),
    revokeConnections(env, user.id).catch(() => {}),
  ]));

  // 3. Files people attached or Lumio made (picture bytes live in R2).
  const files = (await env.DB.prepare('SELECT id FROM files WHERE user_id = ?1').bind(user.id).all<{ id: string }>()).results || [];
  if (files.length && env.FILES) {
    for (let i = 0; i < files.length; i += 500) await env.FILES.delete(files.slice(i, i + 500).map((f) => `files/${f.id}`));
  }

  // 4. Everything else, in one transaction.
  const id = user.id;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?1)').bind(id),
    env.DB.prepare('DELETE FROM chats WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM files WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM connections WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM connect_states WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_items WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_meta WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_pairings WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_devices WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_keys WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_key_events WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM companion_messages WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM app_codes WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM cancellations WHERE user_id = ?1').bind(id),
    env.DB.prepare("UPDATE plan_codes SET redeemed_by = 'deleted' WHERE redeemed_by = ?1").bind(id),
    env.DB.prepare("UPDATE steps SET owner = 'deleted', result = NULL WHERE owner = ?1").bind(id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM email_codes WHERE email = ?1').bind(user.email),
    env.DB.prepare('DELETE FROM auth_attempts WHERE email_hash = ?1').bind(await emailHash(user.email)),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id),
  ]);
  const url = new URL(request.url);
  return json({ ok: true }, 200, { 'set-cookie': `${cookieName(url)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}` });
}
