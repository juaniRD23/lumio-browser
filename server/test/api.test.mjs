// Tests the Lumio server with D1 simulated on node:sqlite and stand-ins for
// Google (sign-in), Stripe (billing) and OpenRouter (the model).
// Run: npm test   (Node 24 runs the TypeScript directly)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { BROWSER_DEFAULT, CHAT_DEFAULT, ceiling, findModel } from '../src/models.ts';
import { IMAGE_MODEL } from '../src/images.ts';
import { PLANS, weeklyBudget } from '../src/usage.ts';

const SITE = 'https://lumio.test';
const OR = 'https://openrouter.test/api/v1';
const GOOGLE_TOKEN = 'https://google.test/token';
const STRIPE = 'https://stripe.test';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const WHSEC = 'whsec_test_secret';
const MS_AUTH = 'https://ms.test/authorize';
const MS_TOKEN = 'https://ms.test/token';
const GAPI = 'https://gapi.test';
const GRAPH = 'https://graph.test/v1.0';

let sql, env, calls, reply, imageReply, apiReply, pending, stripeState, r2;

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
// A tiny PNG and an R2 stand-in.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const PNG_URL = 'data:image/png;base64,' + Buffer.from(PNG).toString('base64');
function bucket() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) { store.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType }); },
    async get(key) {
      const o = store.get(key);
      return o ? { body: new Blob([o.bytes]).stream(), arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) } : null;
    },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
  };
}
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = {
    DB: d1(sql), FILES: (r2 = bucket()), OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE: OR,
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'google-secret', GOOGLE_AUTH_URL: 'https://google.test/auth', GOOGLE_TOKEN_URL: GOOGLE_TOKEN,
    STRIPE_SECRET_KEY: 'rk_test_123', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API: STRIPE,
    MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'ms-secret', MICROSOFT_AUTH_URL: MS_AUTH, MICROSOFT_TOKEN_URL: MS_TOKEN,
    GOOGLE_API: GAPI, GRAPH_API: GRAPH, CONNECTIONS_KEY: Buffer.from(crypto.randomBytes(32)).toString('base64'),
  };
  calls = { or: [], google: [], stripe: [], api: [], revoked: [] };
  apiReply = () => Response.json({}, { status: 404 });
  reply = () => textReply('Hello from Luna.');
  imageReply = () => Response.json({ choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: PNG_URL } }] } }], usage: { prompt_tokens: 20, completion_tokens: 1100, cost: 0.0094 } });
  pending = [];
  stripeState = { subscriptions: {} };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === `${OR}/chat/completions`) {
      const body = JSON.parse(opts.body);
      calls.or.push({ headers: opts.headers, body });
      return body.model === IMAGE_MODEL.id ? imageReply(body) : reply(body);
    }
    if (u === GOOGLE_TOKEN || u === MS_TOKEN) {
      const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
      calls.google.push(body);
      const ms = u === MS_TOKEN;
      if (body.grant_type === 'refresh_token') return Response.json({ access_token: `${ms ? 'm' : 'g'}-access-${calls.google.filter((c) => c.grant_type === 'refresh_token').length + 1}`, expires_in: 3600 });
      if (body.code === 'conn-google') return Response.json({ access_token: 'g-access-1', refresh_token: 'g-refresh', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly', id_token: jwt({ email: 'sam@gmail.com' }) });
      if (body.code === 'conn-ms') return Response.json({ access_token: 'm-access-1', refresh_token: 'm-refresh', expires_in: 3600, scope: 'Files.Read User.Read openid email', id_token: jwt({ preferred_username: 'sam@outlook.com' }) });
      const who = { good: { sub: 'g-111', email: 'Sam@Example.com', name: 'Sam Tester' }, other: { sub: 'g-222', email: 'lee@example.com', name: 'Lee' } }[body.code];
      if (!who || body.client_secret !== 'google-secret' || !body.code_verifier) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ id_token: jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...who }) });
    }
    if (u.startsWith(GAPI) || u.startsWith(GRAPH)) { calls.api.push({ url: u, auth: opts.headers?.authorization }); return apiReply(u, opts); }
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) { calls.revoked.push(u); return new Response('', { status: 200 }); }
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
      ...(body && method !== 'GET' ? { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json', origin } : {}),
      ...headers,
    },
    body: body ? (typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)) : undefined,
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
const step = (extra = {}) => ({ version: 1, taskId: 'chat-1', runId: 'run-1', stepId: 's1', model: BROWSER_DEFAULT, reasoning: 'medium', tools: ['read_page', 'click', 'update_plan'], context, messages: [{ role: 'user', content: 'Summarize this page' }], ...extra });
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
  assert.deepEqual(usage.windows.map((w) => [w.id, w.limit]), [['weekly', Math.floor(PLANS.pro.weekly * 1e6)]]);
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
  assert.equal(calls.or[0].body.model, CHAT_DEFAULT);
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
  sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('old', ?, 'free', 'chat', 'h', 'done', 0, 19950, ?)").run(userRow().id, Date.now() - 1000);
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
  assert.equal(caps.model.id, BROWSER_DEFAULT);
  assert.ok(caps.models.every((m) => m.available));
  assert.ok(caps.tools.includes('update_plan'));
  assert.deepEqual(caps.usage.windows.map((w) => [w.id, w.limit]), [['weekly', 20000]], 'no 5-hour limit');

  const ev = await events(await call('/v1/agent', { token, method: 'POST', body: step({ reasoning: 'high' }) }));
  await settled();
  assert.equal(ev.at(-1).type, 'result');
  assert.equal(ev.at(-1).message.content, 'Hello from Luna.');
  assert.deepEqual(calls.or[0].body.reasoning, { effort: 'high', exclude: true });
  assert.equal(calls.or[0].body.model, BROWSER_DEFAULT);
  assert.deepEqual(calls.or[0].body.provider.max_price, ceiling(findModel(BROWSER_DEFAULT)));
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

  // A tool the step didn't offer: the model is told, tries once more, then the step fails.
  const before = calls.or.length;
  reply = () => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'run_shell', arguments: '{"command":"x","explanation":"x"}' } }] }, finish_reason: 'tool_calls' }] }]);
  const refused = await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's3' }) }));
  await settled();
  assert.equal(refused.at(-1).code, 'invalid_tool_arguments');
  assert.equal(calls.or.length, before + 2);
  assert.match(calls.or.at(-1).body.messages.at(-1).content, /no tool named "run_shell"/);
  assert.ok(!refused.some((e) => e.type === 'tool_call'), 'nothing to run');

  env.FREE_DAILY_CAP_USD = '0.0001';
  const capped = await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's4' }) });
  assert.equal(capped.status, 429);
  assert.match((await capped.json()).error, /capacity for Free accounts/);
});

test('bad browser steps and provider failures', async () => {
  const { token } = await signIn();
  for (const bad of [step({ reasoning: 'extreme' }), step({ tools: ['write_file'] }), { nope: true }]) {
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

test('browser: small slips in tool arguments are fixed, and a bad call gets one retry with the reason', async () => {
  const { token } = await signIn();
  const toolCall = (name, args, id = 'call_1') => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.00001 } }]);
  // "12" for 12, "false" for false, null for an optional field, a field the tool doesn't take, and a ```json fence.
  reply = () => toolCall('click', '```json\n{"ref":"[12]","double":"false","tab_id":null,"why":"x"}\n```');
  const fixed = await events(await call('/v1/agent', { token, method: 'POST', body: step() }));
  await settled();
  assert.deepEqual(fixed.find((e) => e.type === 'tool_call').tool_call.function, { name: 'click', arguments: '{"ref":12,"double":false}' });
  assert.equal(calls.or.length, 1);
  // Plan statuses in other words.
  reply = () => toolCall('update_plan', '{"steps":[{"title":"Look","status":"completed"},{"title":"Buy","status":"In Progress"},{"title":"Pay","status":"todo"}]}');
  const plan = await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's2' }) }));
  await settled();
  assert.deepEqual(JSON.parse(plan.find((e) => e.type === 'tool_call').tool_call.function.arguments).steps.map((x) => x.status), ['done', 'in_progress', 'pending']);
  // Missing a required argument: the model sees why and fixes it on the second try (both calls are billed).
  let n = 0;
  reply = () => (n++ === 0 ? toolCall('click', '{"double":true}', 'call_x') : toolCall('click', '{"ref":7}', 'call_y'));
  const retried = await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's3' }) }));
  await settled();
  const second = calls.or.at(-1).body.messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.equal(second.at(-2).tool_calls[0].id, 'call_x');
  assert.deepEqual({ role: second.at(-1).role, id: second.at(-1).tool_call_id }, { role: 'tool', id: 'call_x' });
  assert.match(second.at(-1).content, /missing "ref"/);
  const result = retried.find((e) => e.type === 'result');
  assert.deepEqual(result.message.tool_calls.map((c) => [c.id, c.function.arguments]), [['call_y', '{"ref":7}']]);
  assert.equal(sql.prepare("SELECT cost_microusd FROM steps ORDER BY created_at DESC LIMIT 1").get().cost_microusd, 20);
});

test('web Chat: people pick a model; bigger ones need a paid plan', async () => {
  const { token } = await signIn();
  const list = await (await call('/api/chat/models', { cookie: token })).json();
  assert.equal(list.default, CHAT_DEFAULT);
  const free = list.models.filter((m) => m.available).map((m) => m.id);
  assert.ok(free.includes(CHAT_DEFAULT));
  assert.ok(list.models.every((m) => m.available === (m.minimumPlan === 'free')));
  assert.ok(list.models.every((m) => m.cost >= 1 && m.cost <= 4 && m.name && m.maker && m.blurb));
  // A free model works; its price ceiling goes to OpenRouter.
  const pick = list.models.find((m) => m.available && m.id !== CHAT_DEFAULT);
  await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'Hi', model: pick.id } }));
  await settled();
  assert.equal(calls.or[0].body.model, pick.id);
  assert.deepEqual(calls.or[0].body.provider.max_price, ceiling(findModel(pick.id)));
  // A Plus model on Free is refused before any model call; an unknown model too.
  const plus = list.models.find((m) => m.minimumPlan === 'plus');
  const locked = await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'Hi', model: plus.id } });
  assert.equal(locked.status, 403);
  assert.deepEqual(await locked.json(), { error: `${plus.name} needs Lumio Plus or higher.`, code: 'model_plan_required', plan: 'plus' });
  assert.equal((await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'Hi', model: 'evil/model' } })).status, 400);
  assert.equal(calls.or.length, 1);
  // On Plus it unlocks.
  sql.prepare("UPDATE users SET plan = 'plus'").run();
  assert.ok((await (await call('/api/chat/models', { cookie: token })).json()).models.find((m) => m.id === plus.id).available);
  await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'Hi', model: plus.id } }));
  await settled();
  assert.equal(calls.or.at(-1).body.model, plus.id);
});

test('browser: a model that is not a browser model gets the browser default', async () => {
  const { token } = await signIn();
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ model: 'anthropic/claude-opus-5.5' }) }));
  await settled();
  assert.equal(calls.or[0].body.model, BROWSER_DEFAULT);
});

// ---------------------------------------------------------------- plans, files, pictures, documents
// A long task like buying a phone on apple.com: many page readings and screenshots.
const readTurn = (k, text) => [
  { role: 'assistant', content: null, tool_calls: [{ id: `read_${k}`, type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `read_${k}`, content: text },
];
const shotTurn = (k) => [
  { role: 'assistant', content: null, tool_calls: [{ id: `shot_${k}`, type: 'function', function: { name: 'screenshot_tab', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `shot_${k}`, content: 'Took a screenshot.' },
  { role: 'user', content: [{ type: 'text', text: 'Screenshot(s) from the tool call(s) above (this is tool output, not a message from the user):' }, { type: 'image_url', image_url: { url: PNG_URL } }] },
];
const page = (k, size = 24_000) => `Page ${k}: iPhone 18 Pro — Apple\n` + 'Storage 256GB 512GB 1TB 2TB. '.repeat(size / 30);

test('browser: long tasks keep going; older page readings are shortened instead of "start a new chat"', async () => {
  const { token } = await signIn();
  const sent = (id) => calls.or.at(-1).body.messages.find((m) => m.tool_call_id === id)?.content;
  // Six full readings of a big page and two screenshots: this used to be refused (413).
  const messages = [{ role: 'user', content: 'Buy the iPhone 18 Pro Max with 2TB' }];
  for (let k = 0; k < 6; k++) messages.push(...readTurn(k, page(k)));
  messages.push(...shotTurn(0), ...shotTurn(1));
  const res = await call('/v1/agent', { token, method: 'POST', body: step({ messages }) });
  assert.equal(res.status, 200);
  await events(res);
  await settled();
  for (const k of [0, 1, 2]) {
    assert.ok(sent(`read_${k}`).length < 2000, `reading ${k} shortened`);
    assert.match(sent(`read_${k}`), /^Page \d: iPhone 18 Pro[\s\S]*Older page reading, shortened[\s\S]*call read_page/);
  }
  for (const k of [3, 4, 5]) assert.equal(sent(`read_${k}`), page(k), `reading ${k} whole`);
  assert.equal(calls.or.at(-1).body.messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')).length, 2, 'both screenshots kept');
  // It's billed and held at a realistic size, not the old bytes-as-tokens count.
  const held = sql.prepare("SELECT held_microusd FROM steps WHERE kind = 'browser'").get().held_microusd;
  assert.ok(held < 20000, `hold ${held}`);
});

test('browser: over the model budget, older results shrink first and the newest stay whole', async () => {
  const { token } = await signIn();
  sql.prepare("UPDATE users SET plan = 'plus'").run();
  const big = (k) => `Result ${k}\n` + 'Order summary line. '.repeat(3000); // ~60K characters each
  const messages = [{ role: 'user', content: 'Compare my last 12 orders' }];
  for (let k = 0; k < 12; k++) messages.push(
    { role: 'assistant', content: null, tool_calls: [{ id: `tabs_${k}`, type: 'function', function: { name: 'list_tabs', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `tabs_${k}`, content: big(k) },
  );
  const res = await call('/v1/agent', { token, method: 'POST', body: step({ messages }) });
  assert.equal(res.status, 200);
  await events(res);
  await settled();
  const body = calls.or.at(-1).body.messages;
  const out = (k) => body.find((m) => m.tool_call_id === `tabs_${k}`).content;
  assert.match(out(0), /Older result, shortened to save space/);
  assert.equal(out(11), big(11), 'the latest result is whole');
  assert.equal(body[1].content, 'Compare my last 12 orders', 'the request is whole');
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(bytes / 3 < 160_000, `fits the budget (${bytes} bytes)`);

  // Files too long to read at once are cut with a note the model can mention.
  const huge = Array.from({ length: 3 }, (_, k) => ({ type: 'text', text: `File ${k}\n` + 'Chapter text. '.repeat(21_000) }));
  const res2 = await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's2', messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize these books' }, ...huge] }] }) });
  assert.equal(res2.status, 200);
  await events(res2);
  await settled();
  const parts = calls.or.at(-1).body.messages[1].content;
  assert.equal(parts[0].text, 'Summarize these books');
  assert.ok(parts.slice(1).some((p) => /Shortened to fit what Lumio can read at once: \d+ more characters not shown/.test(p.text)));
  assert.ok(Buffer.byteLength(JSON.stringify(parts)) / 3 < 160_000);
});

test('plan budgets: Plus leaves 15% profit after fees; Pro and Max are set higher; no 5-hour limit', async () => {
  // Price - 15% profit - Stripe (3.6% + $0.30) - OpenRouter's 5.5% fee, per week.
  assert.equal(weeklyBudget(20), 3.48);
  assert.equal(weeklyBudget(100), 17.67);
  assert.equal(weeklyBudget(200), 35.42);
  assert.deepEqual([PLANS.free.weekly, PLANS.plus.weekly, PLANS.pro.weekly, PLANS.max.weekly], [0.02, 3.48, 20, 40]);
  // No paid plan loses money even at 100% use.
  for (const id of ['plus', 'pro', 'max']) {
    const p = PLANS[id];
    assert.ok(p.price - p.weekly * (365.25 / 12 / 7) * 1.055 - (p.price * 0.036 + 0.3) > 0, `${id} is profitable at full use`);
  }
  for (const id of ['plus']) {
    const p = PLANS[id];
    const monthlyAi = p.weekly * (365.25 / 12 / 7) * 1.055;
    const fees = p.price * 0.036 + 0.3;
    const profit = p.price - monthlyAi - fees;
    assert.ok(profit >= p.price * 0.15 && profit < p.price * 0.151, `${id}: ${profit}`);
  }
  const plans = (await (await call('/api/billing/plans')).json()).plans;
  assert.deepEqual(plans.map((p) => p.weeklyUsd), [0.02, 3.48, 20, 40]);
});

test('Chat: attach pictures and documents; the model sees them; only the owner can read them', async () => {
  const { token } = await signIn();
  const up = await call('/api/files', { cookie: token, method: 'POST', body: PNG, headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('cat photo.png') } });
  const pic = (await up.json()).file;
  assert.equal(pic.kind, 'image');
  assert.equal(pic.url, `/api/files/${pic.id}`);
  assert.ok(r2.store.has(`files/${pic.id}`));
  const doc = (await (await call('/api/files', { cookie: token, method: 'POST', body: { name: 'notes.pdf', mime: 'application/pdf', text: 'Budget: $4,200', pages: 3 } })).json()).file;
  assert.deepEqual({ kind: doc.kind, name: doc.name, pages: doc.pages }, { kind: 'text', name: 'notes.pdf', pages: 3 });
  // Not a picture, or too many files: refused.
  assert.equal((await call('/api/files', { cookie: token, method: 'POST', body: 'hello', headers: { 'content-type': 'image/png' } })).status, 415);
  assert.equal((await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'hi', files: Array.from({ length: 11 }, (_, i) => `f_${String(i).padStart(24, '0')}`) } })).status, 400);

  const ev = await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'What is in these?', files: [pic.id, doc.id] } }));
  await settled();
  assert.equal(ev.at(-1).type, 'done');
  const userMsg = calls.or[0].body.messages.at(-1);
  assert.equal(userMsg.role, 'user');
  assert.ok(userMsg.content.some((p) => p.type === 'image_url' && p.image_url.url === PNG_URL));
  assert.ok(userMsg.content.some((p) => p.type === 'text' && p.text.includes('<file name="notes.pdf" pages="3">') && p.text.includes('Budget: $4,200')));
  assert.equal(userMsg.content.at(-1).text, 'What is in these?');
  const chat = await (await call(`/api/chats/${ev[0].chatId}`, { cookie: token })).json();
  assert.deepEqual(chat.messages[0].files.map((f) => f.id), [pic.id, doc.id]);
  // The picture is the owner's only; a used attachment can't move to another chat.
  assert.equal((await call(pic.url, { cookie: token })).headers.get('content-type'), 'image/png');
  const other = await signIn('other');
  assert.equal((await call(pic.url, { cookie: other.token })).status, 404);
  assert.equal((await call('/api/chat', { cookie: other.token, method: 'POST', body: { text: 'mine?', files: [pic.id] } })).status, 400);
  // Deleting the chat deletes its files.
  await call(`/api/chats/${ev[0].chatId}`, { cookie: token, method: 'DELETE', body: {} });
  assert.equal(r2.store.size, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
});

test('Chat: Lumio makes a picture (cheapest image model, billed) and writes a document', async () => {
  const { token } = await signIn();
  sql.prepare("UPDATE users SET plan = 'plus'").run();
  const toolCall = (name, args) => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_t', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.00001 } }]);
  let n = 0;
  reply = () => (n++ === 0 ? toolCall('generate_image', { prompt: 'A red fox in snow, watercolor', aspect: 'landscape' }) : textReply('Here is your fox.'));
  const ev = await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'Draw a fox' } }));
  await settled();
  const img = calls.or.find((c) => c.body.model === IMAGE_MODEL.id).body;
  assert.deepEqual(img.modalities, ['image', 'text']);
  assert.equal(img.image_config.aspect_ratio, '3:2');
  assert.equal(img.provider.data_collection, 'deny');
  const file = ev.find((e) => e.type === 'file').file;
  assert.equal(file.kind, 'image');
  assert.equal(file.generated, true);
  assert.equal(ev.at(-1).type, 'done');
  assert.match(ev.filter((e) => e.type === 'delta').map((e) => e.content).join(''), /Here is your fox/);
  assert.ok(calls.or[0].body.tools.some((t) => t.function.name === 'generate_image'));
  assert.equal(calls.or.at(-1).body.messages.at(-1).role, 'tool');
  assert.equal(sql.prepare("SELECT cost_microusd FROM steps WHERE kind = 'image'").get().cost_microusd, 9400);
  const saved = await (await call(`/api/chats/${ev[0].chatId}`, { cookie: token })).json();
  assert.equal(saved.messages[1].files[0].id, file.id);

  // A document: kept as its content, downloadable as text by the page (which builds the PDF).
  n = 0;
  reply = () => (n++ === 0 ? toolCall('create_document', { title: 'Trip Plan', format: 'pdf', content: '# Lisbon\n\n- Day 1' }) : textReply('Your PDF is ready.'));
  const ev2 = await events(await call('/api/chat', { cookie: token, method: 'POST', body: { chatId: ev[0].chatId, text: 'Make it a PDF' } }));
  await settled();
  const docFile = ev2.find((e) => e.type === 'file').file;
  assert.deepEqual({ kind: docFile.kind, name: docFile.name, format: docFile.format }, { kind: 'document', name: 'Trip Plan.pdf', format: 'pdf' });
  const got = await (await call(`/api/files/${docFile.id}`, { cookie: token })).json();
  assert.equal(got.text, '# Lisbon\n\n- Day 1');
  // The next turn tells the model what it made.
  reply = () => textReply('ok');
  await events(await call('/api/chat', { cookie: token, method: 'POST', body: { chatId: ev[0].chatId, text: 'thanks' } }));
  await settled();
  assert.ok(calls.or.at(-1).body.messages.some((m) => m.role === 'assistant' && /You made a picture \(“A red fox/.test(m.content)));
});

test('pictures: out of allowance is a plain refusal; Lumio Browser gets the picture inline', async () => {
  const { token } = await signIn();
  sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('x', ?, 'free', 'chat', 'h', 'done', 0, 40000, ?)").run(userRow().id, Date.now() - 1000);
  const refused = await call('/v1/images', { token, method: 'POST', body: { prompt: 'a cat' } });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'Making pictures needs Lumio Plus or higher. Upgrade to make pictures.', code: 'usage_limit' });
  sql.prepare("UPDATE users SET plan = 'plus'").run();
  const ok = await (await call('/v1/images', { token, method: 'POST', body: { prompt: 'a cat', aspect: 'portrait' } })).json();
  assert.equal(ok.image, PNG_URL);
  assert.equal(calls.or.at(-1).body.image_config.aspect_ratio, '2:3');
  // The model refusing is a clear message, and nothing is charged.
  imageReply = () => Response.json({ error: { message: 'Request blocked by safety system' } }, { status: 400 });
  const no = await call('/v1/images', { token, method: 'POST', body: { prompt: 'something' } });
  assert.equal((await no.json()).code, 'image_refused');
  assert.equal(sql.prepare("SELECT cost_microusd FROM steps WHERE kind = 'image' AND status = 'failed'").get().cost_microusd, 0);
});

// ---------------------------------------------------------------- connections
// A ZIP with stored (uncompressed) entries, enough for the Office reader.
function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name), d = enc.encode(text);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true); lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const c = new Uint8Array(46 + n.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true);
    c.set(n, 46);
    parts.push(local, d); central.push(c);
    offset += local.length + d.length;
  }
  const size = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true); ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let at = 0; for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
const DOCX = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p><w:p><w:r><w:t>Grow sales &amp; hire</w:t></w:r></w:p></w:body></w:document>' });

async function connect(token, app, code, provider) {
  const start = await call(`/api/connect/${app}/start?next=/chat`, { cookie: token });
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  const back = await call(`/api/connect/${provider}/callback?code=${code}&state=${auth.searchParams.get('state')}`, { cookie: token });
  return { auth, location: back.headers.get('location') };
}

test('connections: connect Gmail with Google; tokens are encrypted; Chat searches mail; tokens refresh', async () => {
  const { token } = await signIn();
  const before = (await (await call('/api/connections', { cookie: token })).json()).apps;
  assert.ok(before.length >= 9 && before.every((a) => a.available && !a.connected));
  const { auth, location } = await connect(token, 'gmail', 'conn-google', 'google');
  assert.equal(auth.origin + auth.pathname, 'https://google.test/auth');
  assert.match(auth.searchParams.get('scope'), /gmail\.readonly/);
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal(auth.searchParams.get('redirect_uri'), `${SITE}/api/connect/google/callback`);
  assert.equal(location, '/chat?connected=gmail');
  const row = sql.prepare('SELECT * FROM connections').get();
  assert.equal(row.account, 'sam@gmail.com');
  assert.ok(!row.tokens.includes('g-access-1') && !row.tokens.includes('g-refresh'), 'tokens are encrypted');
  const apps = (await (await call('/api/connections', { cookie: token })).json()).apps;
  assert.deepEqual(apps.filter((a) => a.connected).map((a) => a.id), ['gmail']);

  // Chat: the model gets Gmail tools and reads the inbox.
  let n = 0;
  reply = () => (n++ === 0 ? sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_g', type: 'function', function: { name: 'gmail_search', arguments: '{"query":"from:boss"}' } }] }, finish_reason: 'tool_calls' }] }]) : textReply('Your boss sent the Q3 numbers.'));
  let first401 = true;
  apiReply = (u, opts) => {
    if (first401) { first401 = false; return new Response('', { status: 401 }); } // expired: refresh and retry
    if (u.includes('/gmail/v1/users/me/messages?')) return Response.json({ messages: [{ id: 'm1' }] });
    if (u.includes('/messages/m1?format=metadata')) return Response.json({ id: 'm1', snippet: 'See attached', payload: { headers: [{ name: 'From', value: 'Boss <boss@co.com>' }, { name: 'Subject', value: 'Q3 numbers' }, { name: 'Date', value: 'Tue' }] } });
    if (u.includes('/messages/m1?format=full')) return Response.json({ payload: { headers: [{ name: 'Subject', value: 'Q3 numbers' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Revenue up 12%').toString('base64url') } }] } });
    return Response.json({}, { status: 404 });
  };
  const ev = await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'Anything from my boss?' } }));
  await settled();
  assert.ok(calls.or[0].body.tools.some((t) => t.function.name === 'gmail_search'));
  assert.match(calls.or[0].body.messages[0].content, /Connected apps.*Gmail/);
  assert.deepEqual(ev.find((e) => e.type === 'using'), { type: 'using', app: 'gmail', name: 'Gmail', tool: 'gmail_search' });
  assert.match(calls.or[1].body.messages.at(-1).content, /Subject: Q3 numbers/);
  assert.ok(calls.google.some((c) => c.grant_type === 'refresh_token' && c.refresh_token === 'g-refresh'));
  assert.equal(calls.api.at(-1).auth, 'Bearer g-access-2');
  // Turned off for this chat: no Gmail tools.
  reply = () => textReply('ok');
  await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'hi', apps: [] } }));
  await settled();
  assert.ok(!calls.or.at(-1).body.tools.some((t) => t.function.name.startsWith('gmail')));

  // Lumio Browser runs the same tools through the server.
  const caps = await (await call('/v1/agent', { token })).json();
  assert.ok(caps.tools.includes('gmail_read'));
  assert.deepEqual(caps.remoteTools.map((t) => t.app), ['Gmail', 'Gmail']);
  const read = await (await call('/v1/tools/run', { token, method: 'POST', body: { name: 'gmail_read', arguments: '{"message_id":"m1"}' } })).json();
  assert.match(read.text, /Revenue up 12%/);
  assert.equal((await call('/v1/tools/run', { token, method: 'POST', body: { name: 'drive_search', arguments: '{"query":"x"}' } })).status, 400, 'Drive isn’t connected');

  // Disconnecting the last Google app revokes and forgets the tokens.
  const after = (await (await call('/api/connections/gmail/disconnect', { cookie: token, method: 'POST', body: {} })).json()).apps;
  assert.ok(after.every((a) => !a.connected));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 0);
  assert.equal(calls.revoked.length, 1);
});

test('connections: Microsoft OneDrive (Word, PowerPoint, Excel) reads a Word file; Office uploads are read too', async () => {
  const { token } = await signIn();
  const { auth, location } = await connect(token, 'word', 'conn-ms', 'microsoft');
  assert.equal(auth.origin + auth.pathname, MS_AUTH);
  assert.match(auth.searchParams.get('scope'), /Files\.Read/);
  assert.match(auth.searchParams.get('scope'), /offline_access/);
  assert.equal(location, '/chat?connected=word');
  const apps = (await (await call('/api/connections', { cookie: token })).json()).apps;
  assert.deepEqual(apps.filter((a) => a.connected).map((a) => a.id), ['onedrive', 'word', 'powerpoint', 'excel']);
  apiReply = (u) => {
    if (u.endsWith('/content')) return new Response(DOCX);
    if (u.includes('/me/drive/items/item1')) return Response.json({ id: 'item1', name: 'Plan.docx', size: DOCX.length, webUrl: 'https://onedrive.test/plan', file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
    return Response.json({}, { status: 404 });
  };
  const read = await (await call('/v1/tools/run', { token, method: 'POST', body: { name: 'onedrive_read', arguments: { item_id: 'item1' } } })).json();
  assert.match(read.text, /File: Plan\.docx[\s\S]*Quarterly plan\nGrow sales & hire/);
  assert.equal(calls.api.at(-1).auth, 'Bearer m-access-1');
  // A Word file attached in Chat is read on the server.
  const up = await (await call('/api/files', { cookie: token, method: 'POST', body: DOCX, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x-file-name': 'Plan.docx' } })).json();
  assert.equal(up.file.kind, 'text');
  const doc = await (await call(`/api/files/${up.file.id}`, { cookie: token })).json();
  assert.equal(doc.text, 'Quarterly plan\nGrow sales & hire');
  // Someone else's callback can't land on this account.
  const other = await signIn('other');
  const start = await call('/api/connect/outlook/start?next=/chat', { cookie: token });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const stolen = await call(`/api/connect/microsoft/callback?code=conn-ms&state=${state}`, { cookie: other.token });
  assert.match(stolen.headers.get('location'), /connect_error=expired/);
});
