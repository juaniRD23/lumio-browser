// Tests the Lumio server with D1 simulated on node:sqlite and stand-ins for
// Google (sign-in), Stripe (billing) and OpenRouter (the model).
// Run: npm test   (Node 24 runs the TypeScript directly)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';

const SITE = 'https://lumio.test';
const OR = 'https://openrouter.test/api/v1';
const GOOGLE_TOKEN = 'https://google.test/token';
const STRIPE = 'https://stripe.test';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const WHSEC = 'whsec_test_secret';

let sql, env, calls, reply, pending, stripeState;

function d1(db) {
  return {
    prepare(query) {
      let values = [];
      const stmt = {
        bind(...args) { values = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async first() { return db.prepare(query).get(...values) ?? null; },
        async all() { return { results: db.prepare(query).all(...values) }; },
        async run() { db.prepare(query).run(...values); return { success: true }; },
      };
      return stmt;
    },
  };
}

const sse = (chunks) => new Response(chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const textReply = (text, cost = 0.000321) => sse([
  ': OPENROUTER PROCESSING',
  { choices: [{ index: 0, delta: { content: text.slice(0, 5) } }] },
  { choices: [{ index: 0, delta: { content: text.slice(5) }, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 40, total_tokens: 3040, cost } },
  '[DONE]',
]);
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = {
    DB: d1(sql), OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE: OR,
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'google-secret', GOOGLE_AUTH_URL: 'https://google.test/auth', GOOGLE_TOKEN_URL: GOOGLE_TOKEN,
    STRIPE_SECRET_KEY: 'rk_test_123', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API: STRIPE,
  };
  calls = { or: [], google: [], stripe: [] };
  reply = () => textReply('Hello from Luna.');
  pending = [];
  stripeState = { subscriptions: {} };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === `${OR}/chat/completions`) { calls.or.push({ headers: opts.headers, body: JSON.parse(opts.body) }); return reply(); }
    if (u === GOOGLE_TOKEN) {
      const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
      calls.google.push(body);
      const who = { good: { sub: 'g-111', email: 'Sam@Example.com', name: 'Sam Tester' }, other: { sub: 'g-222', email: 'lee@example.com', name: 'Lee' } }[body.code];
      if (!who || body.client_secret !== 'google-secret' || !body.code_verifier) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ id_token: jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...who }) });
    }
    if (u.startsWith(STRIPE)) {
      const path = new URL(u).pathname;
      const params = opts.method === 'POST' ? Object.fromEntries(new URLSearchParams(String(opts.body))) : Object.fromEntries(new URL(u).searchParams);
      calls.stripe.push({ method: opts.method || 'GET', path, params });
      if (path === '/v1/customers') return Response.json({ id: 'cus_1' });
      if (path === '/v1/prices') return Response.json({ data: [{ id: 'price_plus', lookup_key: 'lumio_plus_monthly' }, { id: 'price_pro', lookup_key: 'lumio_pro_monthly' }, { id: 'price_max', lookup_key: 'lumio_max_monthly' }] });
      if (path === '/v1/checkout/sessions') return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
      if (path === '/v1/billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.test/p_1' });
      if (path === '/v1/billing_portal/configurations') return Response.json({ data: [{ id: 'bpc_default', metadata: {} }, { id: 'bpc_lumio', metadata: { app: 'lumio' } }] });
      const sub = /^\/v1\/subscriptions\/(\w+)$/.exec(path);
      if (sub && stripeState.subscriptions[sub[1]]) return Response.json(stripeState.subscriptions[sub[1]]);
      return Response.json({ error: { message: 'No such thing' } }, { status: 404 });
    }
    return new Response('nope', { status: 404 });
  };
});

const ctx = { waitUntil: (p) => pending.push(p) };
const settled = async () => { await Promise.all(pending); pending = []; };
function call(path, { cookie, token, method = 'GET', body, origin = SITE, headers = {} } = {}) {
  return worker.fetch(new Request(SITE + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie: `__Host-lumio_session=${cookie}` } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && method !== 'GET' ? { 'content-type': 'application/json', origin } : {}),
      ...headers,
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  }), env, ctx);
}
const events = async (res) => (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Signs in through the whole Google flow and returns the session token.
async function signIn(code = 'good', next = '/chat') {
  const start = await call(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.origin + auth.pathname, 'https://google.test/auth');
  assert.equal(auth.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(auth.searchParams.get('redirect_uri'), `${SITE}/api/auth/google/callback`);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const back = await call(`/api/auth/google/callback?code=${code}&state=${auth.searchParams.get('state')}`);
  assert.equal(back.status, 302);
  const cookie = /__Host-lumio_session=([a-f0-9]{64}); Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/.exec(back.headers.get('set-cookie') || '');
  assert.ok(cookie, back.headers.get('set-cookie'));
  return { token: cookie[1], location: back.headers.get('location') };
}
function signed(event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${sig}` };
}
const hook = (event, header) => { const s = signed(event); return call('/api/stripe/webhook', { method: 'POST', body: s.payload, headers: { 'stripe-signature': header ?? s.header } }); };
const context = { platform: 'mac', computer: true, mode: 'ask', timeZone: 'America/New_York', tabCount: 1 };
const step = (extra = {}) => ({ version: 1, taskId: 'chat-1', runId: 'run-1', stepId: 's1', model: 'openai/gpt-6-luna', reasoning: 'medium', tools: ['read_page', 'click', 'update_plan'], context, messages: [{ role: 'user', content: 'Summarize this page' }], ...extra });
const userRow = () => sql.prepare('SELECT * FROM users').get();

// ---------------------------------------------------------------- accounts
test('Google sign-in creates an account and a session; the cookie and the bearer token both work', async () => {
  assert.deepEqual(await (await call('/api/account')).json(), { signedIn: false, ownerId: null, authMethod: 'guest', email: null, profile: null, username: null, publicUsername: null });
  const { token, location } = await signIn('good', '/chat');
  assert.equal(location, '/chat');
  assert.equal(calls.google[0].client_secret, 'google-secret');
  const me = await (await call('/api/account', { cookie: token })).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.email, 'sam@example.com');
  assert.equal(me.profile.name, 'Sam Tester');
  assert.equal(me.authMethod, 'google');
  assert.equal((await (await call('/api/account', { token })).json()).ownerId, me.ownerId, 'Lumio Browser sends the same session as a bearer token');
  assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM sessions').all()).includes(token), 'only a hash is stored');
  // Signing in again reuses the account.
  await signIn('good');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('sign-in refuses a replayed or unknown state, a bad code and outside redirects', async () => {
  assert.equal((await call('/api/auth/google/callback?code=good&state=nope')).headers.get('location'), '/signin?error=expired');
  const start = await call('/api/auth/google/start?next=//evil.example/x');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const back = await call(`/api/auth/google/callback?code=bad&state=${state}`);
  assert.equal(back.headers.get('location'), '/signin?error=google');
  assert.equal((await call(`/api/auth/google/callback?code=good&state=${state}`)).headers.get('location'), '/signin?error=expired', 'a state works once');
  const ok = await signIn('good', '//evil.example/x');
  assert.equal(ok.location, '/account', 'next must stay on this site');
});

test('logout ends the session; cookie POSTs from other sites are refused', async () => {
  const { token } = await signIn();
  assert.equal((await call('/api/auth', { cookie: token, method: 'POST', body: { action: 'logout' }, origin: 'https://evil.example' })).status, 403);
  const out = await call('/api/auth', { cookie: token, method: 'POST', body: { action: 'logout' } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await (await call('/api/account', { cookie: token })).json()).signedIn, false);
});

// ---------------------------------------------------------------- billing
test('plans are public; checkout starts a Stripe subscription tagged as Lumio', async () => {
  const plans = (await (await call('/api/billing/plans')).json()).plans;
  assert.deepEqual(plans.map((p) => [p.id, p.price]), [['free', 0], ['plus', 20], ['pro', 100], ['max', 200]]);
  const { token } = await signIn();
  assert.equal((await call('/api/billing/checkout', { method: 'POST', body: { plan: 'plus' } })).status, 401);
  assert.equal((await call('/api/billing/checkout', { cookie: token, method: 'POST', body: { plan: 'gold' } })).status, 400);
  const res = await call('/api/billing/checkout', { cookie: token, method: 'POST', body: { plan: 'pro' } });
  assert.deepEqual(await res.json(), { url: 'https://checkout.stripe.test/cs_1' });
  const customer = calls.stripe.find((c) => c.path === '/v1/customers').params;
  assert.equal(customer['metadata[app]'], 'lumio');
  const s = calls.stripe.find((c) => c.path === '/v1/checkout/sessions').params;
  assert.equal(s.mode, 'subscription');
  assert.equal(s.customer, 'cus_1');
  assert.equal(s['line_items[0][price]'], 'price_pro');
  assert.equal(s['metadata[app]'], 'lumio');
  assert.equal(s['subscription_data[metadata][app]'], 'lumio');
  assert.equal(s.client_reference_id, userRow().id);
  assert.equal(s.success_url, `${SITE}/account?upgraded=1`);
  assert.equal(userRow().stripe_customer_id, 'cus_1');
});

test('the signed webhook sets the plan from the subscription, and ignores other payments', async () => {
  const { token } = await signIn();
  const id = userRow().id;
  stripeState.subscriptions.sub_1 = { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { app: 'lumio', user_id: id }, items: { data: [{ price: { lookup_key: 'lumio_pro_monthly' }, current_period_end: 1893456000 }] } };
  const completed = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: id, metadata: { app: 'lumio', user_id: id } } } };
  assert.equal((await hook(completed, 't=1,v1=' + 'a'.repeat(64))).status, 400, 'bad signature');
  assert.deepEqual(await (await hook(completed)).json(), { ok: true, result: 'pro' });
  assert.equal(userRow().plan, 'pro');
  assert.deepEqual(await (await hook(completed)).json(), { ok: true, duplicate: true });
  const usage = (await (await call('/api/usage', { cookie: token })).json()).usage;
  assert.equal(usage.planName, 'Pro');
  assert.deepEqual(usage.windows.map((w) => [w.id, w.limit]), [['weekly', 13750000]]);
  // A Fifty Sites payment on the same Stripe account changes nothing here.
  const other = { id: 'evt_2', type: 'checkout.session.completed', data: { object: { mode: 'payment', customer: 'cus_9', metadata: {} } } };
  assert.deepEqual(await (await hook(other)).json(), { ok: true, result: 'ignored' });
  // Downgrade in the portal, then cancel.
  const updated = { ...stripeState.subscriptions.sub_1, items: { data: [{ price: { lookup_key: 'lumio_plus_monthly' } }] } };
  await hook({ id: 'evt_3', type: 'customer.subscription.updated', data: { object: updated } });
  assert.equal(userRow().plan, 'plus');
  await hook({ id: 'evt_3b', type: 'customer.subscription.updated', data: { object: { ...updated, cancel_at_period_end: true } } });
  assert.deepEqual([userRow().plan, userRow().plan_status], ['plus', 'canceling'], 'keeps the plan until the period ends');
  assert.equal((await (await call('/api/account', { cookie: token })).json()).plan.status, 'canceling');
  await hook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { ...updated, status: 'canceled' } } });
  assert.equal(userRow().plan, 'free');
  assert.equal(userRow().plan_status, 'canceled');
});

test('subscribed accounts change plans in the billing portal, never a second subscription', async () => {
  const { token } = await signIn();
  sql.prepare("UPDATE users SET plan = 'plus', plan_status = 'active', subscription_id = 'sub_1', stripe_customer_id = 'cus_1'").run();
  const res = await call('/api/billing/checkout', { cookie: token, method: 'POST', body: { plan: 'max' } });
  assert.deepEqual(await res.json(), { url: 'https://billing.stripe.test/p_1' });
  const p = calls.stripe.find((c) => c.path === '/v1/billing_portal/sessions').params;
  assert.equal(p['flow_data[type]'], 'subscription_update');
  assert.equal(p['flow_data[subscription_update][subscription]'], 'sub_1');
  assert.equal(p.configuration, 'bpc_lumio', 'Lumio’s own portal settings, not the account default');
  assert.ok(!calls.stripe.some((c) => c.path === '/v1/checkout/sessions'));
  assert.deepEqual(await (await call('/api/billing/portal', { cookie: token, method: 'POST', body: {} })).json(), { url: 'https://billing.stripe.test/p_1' });
});

// ---------------------------------------------------------------- web Chat
test('web Chat streams a reply, saves the conversation, and bills the allowance', async () => {
  const { token } = await signIn();
  const ev = await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'Hi Lumio', reasoning: 'low' } }));
  await settled();
  assert.equal(ev[0].type, 'chat');
  assert.equal(ev[0].title, 'Hi Lumio');
  assert.equal(ev.filter((e) => e.type === 'delta').map((e) => e.content).join(''), 'Hello from Luna.');
  assert.equal(ev.at(-1).type, 'done');
  assert.deepEqual(calls.or[0].body.reasoning, { effort: 'low', exclude: true });
  assert.equal(calls.or[0].body.model, 'openai/gpt-6-luna');
  assert.equal(calls.or[0].body.messages[0].role, 'system');
  const chatId = ev[0].chatId;
  // Follow-up in the same chat sends the history.
  reply = () => textReply('Still here.');
  await events(await call('/api/chat', { cookie: token, method: 'POST', body: { chatId, text: 'Again?' } }));
  await settled();
  assert.deepEqual(calls.or[1].body.messages.slice(1).map((m) => m.content), ['Hi Lumio', 'Hello from Luna.', 'Again?']);
  const list = (await (await call('/api/chats', { cookie: token })).json()).chats;
  assert.equal(list.length, 1);
  const chat = await (await call(`/api/chats/${chatId}`, { cookie: token })).json();
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(sql.prepare("SELECT SUM(cost_microusd) AS c FROM steps WHERE kind = 'chat'").get().c, 642);
  // Someone else can't read or delete it.
  const other = await signIn('other');
  assert.equal((await call(`/api/chats/${chatId}`, { cookie: other.token })).status, 404);
  assert.equal((await call(`/api/chats/${chatId}`, { cookie: token, method: 'DELETE', body: {} })).status, 200);
  assert.equal((await (await call('/api/chats', { cookie: token })).json()).chats.length, 0);
});

test('out of allowance, Chat and the browser are refused before any model call', async () => {
  const { token } = await signIn();
  sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('old', ?, 'free', 'chat', 'h', 'done', 0, 7000, ?)").run(userRow().id, Date.now() - 1000);
  const res = await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'hi' } });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.code, 'usage_limit');
  assert.match(body.error, /Free plan[\s\S]*Upgrade/);
  assert.equal((await call('/v1/agent', { token, method: 'POST', body: step() })).status, 429);
  assert.equal(calls.or.length, 0);
});

// ---------------------------------------------------------------- Lumio Browser
test('browser: capabilities, a streamed step, tool calls, replays and the Free daily cap', async () => {
  const { token } = await signIn();
  assert.equal((await call('/v1/agent')).status, 401);
  const caps = await (await call('/v1/agent', { token })).json();
  assert.deepEqual(caps.models.map((m) => m.id), ['openai/gpt-6-luna']);
  assert.ok(caps.tools.includes('update_plan'));
  assert.deepEqual(caps.usage.windows.map((w) => [w.id, w.limit]), [['fiveHour', 7142], ['weekly', 50000]]);

  const ev = await events(await call('/v1/agent', { token, method: 'POST', body: step({ reasoning: 'high' }) }));
  await settled();
  assert.equal(ev.at(-1).type, 'result');
  assert.equal(ev.at(-1).message.content, 'Hello from Luna.');
  assert.deepEqual(calls.or[0].body.reasoning, { effort: 'high', exclude: true });
  assert.deepEqual(calls.or[0].body.provider.max_price, { prompt: 0.1, completion: 0.5 });
  assert.deepEqual(calls.or[0].body.tools.map((t) => t.function.name), ['read_page', 'click', 'update_plan']);

  const again = await call('/v1/agent', { token, method: 'POST', body: step({ reasoning: 'high' }) });
  assert.equal(again.headers.get('x-lumio-step-replayed'), 'true');
  assert.equal(calls.or.length, 1, 'replayed, not charged twice');

  reply = () => sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'click', arguments: '{"re' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'f":12}' } }] }, finish_reason: 'tool_calls' }] },
  ]);
  const tools = await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's2' }) }));
  await settled();
  assert.deepEqual(tools.find((e) => e.type === 'tool_call').tool_call.function, { name: 'click', arguments: '{"ref":12}' });

  reply = () => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'run_shell', arguments: '{"command":"x","explanation":"x"}' } }] }, finish_reason: 'tool_calls' }] }]);
  const refused = await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's3' }) }));
  await settled();
  assert.equal(refused.at(-1).code, 'tool_not_allowed');

  env.FREE_DAILY_CAP_USD = '0.0001';
  const capped = await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's4' }) });
  assert.equal(capped.status, 429);
  assert.match((await capped.json()).error, /capacity for Free accounts/);
});

test('bad browser steps and provider failures', async () => {
  const { token } = await signIn();
  for (const bad of [step({ model: 'anthropic/claude-opus-5.5' }), step({ reasoning: 'extreme' }), step({ tools: ['write_file'] }), { nope: true }]) {
    const res = await call('/v1/agent', { token, method: 'POST', body: bad });
    assert.ok(res.status >= 400 && res.status < 500);
  }
  reply = () => new Response('{"error":{"message":"overloaded"}}', { status: 429 });
  const res = await call('/v1/agent', { token, method: 'POST', body: step() });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'provider_unavailable');
  assert.deepEqual({ ...sql.prepare("SELECT status, cost_microusd FROM steps WHERE kind = 'browser'").get() }, { status: 'failed', cost_microusd: 0 });
  reply = () => textReply('Back again.');
  const ok = await events(await call('/v1/agent', { token, method: 'POST', body: step() }));
  await settled();
  assert.equal(ok.at(-1).message.content, 'Back again.');
});
