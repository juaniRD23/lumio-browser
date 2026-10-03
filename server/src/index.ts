// Lumio (lumio-usa.online): the website, accounts (Google sign-in), plans
// (Stripe), web Chat and Lumio Browser's AI, in one Cloudflare Worker.
//
//   /                       website pages (static, from website/public)
//   /api/auth/google/*      sign in with Google
//   POST /api/auth          { action: 'logout' }
//   GET  /api/account       who is signed in (the shape Lumio Browser reads)
//   GET  /api/usage         the plan and its Lumio AI allowance
//   GET  /api/billing/plans the plans and prices
//   POST /api/billing/checkout | /api/billing/portal
//   GET  /api/billing/subscription, GET /api/billing/checkout-status
//   POST /api/billing/change | /api/billing/cancel | /api/billing/resume   (manage the plan in Lumio)
//   POST /api/stripe/webhook
//   GET  /api/chats, GET|DELETE /api/chats/:id, POST /api/chat, GET /api/chat/models   (web Chat)
//   POST /api/files, GET /api/files/:id                            (Chat attachments, made images and files)
//   GET  /api/connections, GET /api/connect/:app/start, GET /api/connect/:provider/callback,
//   POST /api/connections/:app/disconnect                          (connected apps)
//   GET  /v1/agent, POST /v1/agent, GET /v1/usage, POST /v1/images, POST /v1/tools/run,
//   POST /v1/extract, POST /v1/voice/transcribe, POST /v1/voice/speak (Lumio Browser)
//   GET  /api/admin/spend   AI spend vs OpenRouter (the owner only; the /admin page)
//
// Every 5 minutes (cron trigger) recent AI calls are checked against
// OpenRouter's records of what they cost (spend.ts).
//
// Website requests use the session cookie; Lumio Browser sends the same
// session as a bearer token. Cookie-authenticated POSTs must come from our own
// pages (Origin check).
import { accountJson, appFinish, appSession, currentUser, googleCallback, googleStart, logout, readToken, type User } from './auth.ts';
import { cancelPlan, changePlan, checkout, checkoutStatus, portal, resumePlan, subscription, webhook } from './billing.ts';
import { capabilities, runTool, step } from './browser.ts';
import { connectCallback, connectStart, disconnect, listConnections } from './connections.ts';
import { chatModels, deleteChat, getChat, listChats, send } from './chat.ts';
import { download, extract, upload } from './files.ts';
import { imageForBrowser } from './images.ts';
import { speak, transcribe } from './voice.ts';
import {
  companionList, companionPost, companionStatusGet, companionStatusPut, pairAnswer, pairCheck, pairPending, pairRequest,
  pushSubscribe, syncChanges, syncCleanup, syncDeleteAll, syncDevice, syncInit, syncPush, syncRemoveDevice, syncStatus, vapidKey,
} from './sync.ts';
import { spendReport, verifySpend } from './spend.ts';
import { PLANS, allowance } from './usage.ts';
import { AgentError, type Env, fail, json, sameOrigin } from './util.ts';

export type { Env };

const PUBLIC_PLANS = (['free', 'go', 'plus', 'pro', 'max'] as const).map((id) => ({ id, name: PLANS[id].name, price: PLANS[id].price, weeklyUsd: PLANS[id].weekly }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;
    try {
      if (path === '/health') return json({ ok: true, service: 'lumio' });
      if (path === '/api/auth/google/start' && method === 'GET') return await googleStart(request, env);
      if (path === '/api/auth/google/callback' && method === 'GET') return await googleCallback(request, env);
      if (path === '/api/stripe/webhook' && method === 'POST') return await webhook(request, env);
      if (path === '/api/billing/plans' && method === 'GET') return json({ plans: PUBLIC_PLANS });
      // The phone app's sign-in hand-off (its web view posts the one-time code).
      if (path === '/api/auth/app/finish' && method === 'GET') return await appFinish(request, env);
      if (path === '/api/auth/app/session' && method === 'POST') return await appSession(request, env);

      // Everything below knows who is asking.
      const bearer = /^Bearer /.test(request.headers.get('authorization') || '');
      if (method !== 'GET' && !bearer && !sameOrigin(request)) return fail('Not allowed.', 403, 'forbidden');
      const user = await currentUser(request, env);

      if (path === '/api/account' && method === 'GET') return json(accountJson(user));
      const cb = /^\/api\/connect\/(google|microsoft)\/callback$/.exec(path);
      if (cb && method === 'GET') return await connectCallback(request, env, user, cb[1] as 'google' | 'microsoft');
      if (path === '/api/auth' && method === 'POST') {
        const body = await request.clone().json<{ action?: string }>().catch(() => null);
        if (body?.action === 'logout') return await logout(request, env);
        return fail('Unknown action.', 400, 'invalid_request');
      }
      if (path === '/api/usage' && method === 'GET') {
        if (!user) return json({ usage: { plan: 'free', planName: 'Free', remaining: 0, limit: 0, windows: [] }, signedIn: false });
        return json({ usage: await allowance(env, user.id, user.plan) });
      }

      const route = routeFor(path, method);
      if (!route) {
        if (path.startsWith('/api/') || path.startsWith('/v1/')) return fail('Not found.', 404, 'not_found');
        return env.ASSETS ? env.ASSETS.fetch(request) : fail('Not found.', 404, 'not_found');
      }
      if (!user) {
        if (path === '/v1/agent' && method === 'GET') return json({ version: 1, enabled: false, reason: 'Sign in to your Lumio account to use Lumio AI.' }, 401);
        return fail(readToken(request) ? 'Your Lumio session ended. Sign in again.' : 'Sign in to your Lumio account first.', 401, 'sign_in_required');
      }
      return await route(request, env, ctx, user);
    } catch (err) {
      if (err instanceof AgentError) return fail(err.message, err.status, err.code);
      console.error('lumio', (err as Error)?.stack || err);
      return fail('Lumio hit a problem. Try again.', 500, 'server_error');
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(verifySpend(env).then((r) => { if (r.fixed) console.log('lumio spend: corrected', r.fixed, 'of', r.checked, 'calls'); }));
    ctx.waitUntil(syncCleanup(env).catch((err) => console.error('lumio sync cleanup', err)));
  },
};

type Route = (request: Request, env: Env, ctx: ExecutionContext, user: User) => Promise<Response>;

function routeFor(path: string, method: string): Route | null {
  if (path === '/v1/agent' && method === 'GET') return (_r, env, _c, user) => capabilities(env, user);
  if (path === '/v1/agent' && method === 'POST') return step;
  if (path === '/v1/usage' && method === 'GET') return async (_r, env, _c, user) => json({ usage: await allowance(env, user.id, user.plan) });
  if (path === '/v1/images' && method === 'POST') return (r, env, c, user) => imageForBrowser(r, env, user, c);
  if (path === '/v1/voice/transcribe' && method === 'POST') return (r, env, c, user) => transcribe(r, env, user, c);
  if (path === '/v1/voice/speak' && method === 'POST') return (r, env, c, user) => speak(r, env, user, c);
  if (path === '/api/files' && method === 'POST') return (r, env, _c, user) => upload(r, env, user);
  if (path === '/v1/tools/run' && method === 'POST') return (r, env, _c, user) => runTool(r, env, user);
  if (path === '/v1/extract' && method === 'POST') return (r) => extract(r);
  if (path === '/api/connections' && method === 'GET') return (_r, env, _c, user) => listConnections(env, user);
  const cs = /^\/api\/connect\/([a-z_]{2,40})\/start$/.exec(path);
  if (cs && method === 'GET') return (r, env, _c, user) => connectStart(r, env, user, cs[1]);
  const cd = /^\/api\/connections\/([a-z_]{2,40})\/disconnect$/.exec(path);
  if (cd && method === 'POST') return (_r, env, _c, user) => disconnect(env, user, cd[1]);
  const f = /^\/api\/files\/(f_[a-f0-9]{24})$/.exec(path);
  if (f && method === 'GET') return (_r, env, _c, user) => download(env, user, f[1]);
  if (path === '/api/billing/checkout' && method === 'POST') return (r, env, _c, user) => checkout(r, env, user);
  if (path === '/api/billing/portal' && method === 'POST') return (r, env, _c, user) => portal(r, env, user);
  if (path === '/api/billing/subscription' && method === 'GET') return (_r, env, _c, user) => subscription(env, user);
  if (path === '/api/billing/checkout-status' && method === 'GET') return (r, env, _c, user) => checkoutStatus(r, env, user);
  if (path === '/api/billing/change' && method === 'POST') return (r, env, _c, user) => changePlan(r, env, user);
  if (path === '/api/billing/cancel' && method === 'POST') return (r, env, _c, user) => cancelPlan(r, env, user);
  if (path === '/api/billing/resume' && method === 'POST') return (_r, env, _c, user) => resumePlan(env, user);
  if (path === '/api/chats' && method === 'GET') return (_r, env, _c, user) => listChats(env, user);
  if (path === '/api/chat' && method === 'POST') return send;
  if (path === '/api/chat/models' && method === 'GET') return async (_r, _env, _c, user) => chatModels(user);
  if (path === '/api/admin/spend' && method === 'GET') return (_r, env, _c, user) => spendReport(env, user);
  // Sync and the phone companion
  if (path === '/api/sync' && method === 'GET') return (_r, env, _c, user) => syncStatus(env, user);
  if (path === '/api/sync' && method === 'DELETE') return (_r, env, _c, user) => syncDeleteAll(env, user);
  if (path === '/api/sync/init' && method === 'POST') return (r, env, _c, user) => syncInit(r, env, user);
  if (path === '/api/sync/devices' && method === 'POST') return (r, env, _c, user) => syncDevice(r, env, user);
  const sd = /^\/api\/sync\/devices\/([A-Za-z0-9-]{8,64})$/.exec(path);
  if (sd && method === 'DELETE') return (_r, env, _c, user) => syncRemoveDevice(env, user, sd[1]);
  if (path === '/api/sync/changes' && method === 'GET') return (r, env, _c, user) => syncChanges(r, env, user);
  if (path === '/api/sync/push' && method === 'POST') return (r, env, _c, user) => syncPush(r, env, user);
  if (path === '/api/sync/pair' && method === 'POST') return (r, env, _c, user) => pairRequest(r, env, user);
  if (path === '/api/sync/pair' && method === 'GET') return (r, env, _c, user) => pairPending(r, env, user);
  const sp = /^\/api\/sync\/pair\/(p_[a-f0-9]{24})$/.exec(path);
  if (sp && method === 'GET') return (_r, env, _c, user) => pairCheck(env, user, sp[1]);
  if (sp && method === 'POST') return (r, env, _c, user) => pairAnswer(r, env, user, sp[1]);
  if (path === '/api/companion/messages' && method === 'POST') return (r, env, c, user) => companionPost(r, env, user, c);
  if (path === '/api/companion/messages' && method === 'GET') return (r, env, _c, user) => companionList(r, env, user);
  if (path === '/api/companion/status' && method === 'PUT') return (r, env, _c, user) => companionStatusPut(r, env, user);
  if (path === '/api/companion/status' && method === 'GET') return (_r, env, _c, user) => companionStatusGet(env, user);
  if (path === '/api/companion/push' && method === 'POST') return (r, env, _c, user) => pushSubscribe(r, env, user);
  if (path === '/api/companion/vapid' && method === 'GET') return async (_r, env) => vapidKey(env);
  const m = /^\/api\/chats\/(c_[a-f0-9]{20})$/.exec(path);
  if (m && method === 'GET') return (_r, env, _c, user) => getChat(env, user, m[1]);
  if (m && method === 'DELETE') return (_r, env, _c, user) => deleteChat(env, user, m[1]);
  return null;
}
