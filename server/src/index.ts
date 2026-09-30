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
//   POST /api/stripe/webhook
//   GET  /api/chats, GET|DELETE /api/chats/:id, POST /api/chat   (web Chat)
//   GET  /v1/agent, POST /v1/agent, GET /v1/usage                 (Lumio Browser)
//
// Website requests use the session cookie; Lumio Browser sends the same
// session as a bearer token. Cookie-authenticated POSTs must come from our own
// pages (Origin check).
import { accountJson, currentUser, googleCallback, googleStart, logout, readToken, type User } from './auth.ts';
import { checkout, portal, webhook } from './billing.ts';
import { capabilities, step } from './browser.ts';
import { deleteChat, getChat, listChats, send } from './chat.ts';
import { PLANS, allowance } from './usage.ts';
import { AgentError, type Env, fail, json, sameOrigin } from './util.ts';

export type { Env };

const PUBLIC_PLANS = (['free', 'plus', 'pro', 'max'] as const).map((id) => ({ id, name: PLANS[id].name, price: PLANS[id].price, weeklyUsd: PLANS[id].weekly }));

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

      // Everything below knows who is asking.
      const bearer = /^Bearer /.test(request.headers.get('authorization') || '');
      if (method !== 'GET' && !bearer && !sameOrigin(request)) return fail('Not allowed.', 403, 'forbidden');
      const user = await currentUser(request, env);

      if (path === '/api/account' && method === 'GET') return json(accountJson(user));
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
};

type Route = (request: Request, env: Env, ctx: ExecutionContext, user: User) => Promise<Response>;

function routeFor(path: string, method: string): Route | null {
  if (path === '/v1/agent' && method === 'GET') return (_r, env, _c, user) => capabilities(env, user);
  if (path === '/v1/agent' && method === 'POST') return step;
  if (path === '/v1/usage' && method === 'GET') return async (_r, env, _c, user) => json({ usage: await allowance(env, user.id, user.plan) });
  if (path === '/api/billing/checkout' && method === 'POST') return (r, env, _c, user) => checkout(r, env, user);
  if (path === '/api/billing/portal' && method === 'POST') return (r, env, _c, user) => portal(r, env, user);
  if (path === '/api/chats' && method === 'GET') return (_r, env, _c, user) => listChats(env, user);
  if (path === '/api/chat' && method === 'POST') return send;
  const m = /^\/api\/chats\/(c_[a-f0-9]{20})$/.exec(path);
  if (m && method === 'GET') return (_r, env, _c, user) => getChat(env, user, m[1]);
  if (m && method === 'DELETE') return (_r, env, _c, user) => deleteChat(env, user, m[1]);
  return null;
}
