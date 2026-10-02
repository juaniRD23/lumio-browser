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
import { liveCheck, verifySpend } from '../src/spend.ts';

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

let sql, env, calls, reply, imageReply, listenReply, speakReply, apiReply, pending, stripeState, r2, generations, unrecorded, orKey;

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
let genN = 0; // OpenRouter generation IDs, one per reply; OpenRouter keeps a record of each one's cost
const textReply = (text, cost = 0.000321, id = `gen-${++genN}-test`) => (generations[id] ??= cost, sse([
  ': OPENROUTER PROCESSING',
  { id, choices: [{ index: 0, delta: { content: text.slice(0, 5) } }] },
  { id, choices: [{ index: 0, delta: { content: text.slice(5) }, finish_reason: 'stop' }] },
  { id, choices: [], usage: { prompt_tokens: 3000, completion_tokens: 40, total_tokens: 3040, cost } },
  '[DONE]',
]));
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
  calls = { or: [], orGet: [], google: [], stripe: [], api: [], revoked: [] };
  generations = { 'gen-img-test': 0.0094 }; // what OpenRouter's records say each generation cost
  unrecorded = new Set(); // generations OpenRouter hasn't recorded yet
  liveCheck.delays = [0, 0, 0];
  orKey = { usage: 0, usage_daily: 0, usage_weekly: 0, usage_monthly: 0, limit: null, limit_remaining: null };
  apiReply = () => Response.json({}, { status: 404 });
  reply = () => textReply('Hello from Luna.');
  imageReply = () => Response.json({ id: 'gen-img-test', choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: PNG_URL } }] } }], usage: { prompt_tokens: 20, completion_tokens: 1100, cost: 0.0094 } });
  listenReply = () => Response.json({ id: 'gen-stt-test', text: 'What is on this page?', usage: { seconds: 4.2, cost: 0.000014 } });
  speakReply = () => new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-tts-test' } });
  pending = [];
  stripeState = { subscriptions: {} };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === `${OR}/chat/completions`) {
      const body = JSON.parse(opts.body);
      calls.or.push({ headers: opts.headers, body });
      return body.model === IMAGE_MODEL.id ? imageReply(body) : reply(body);
    }
    if (u === `${OR}/audio/transcriptions` || u === `${OR}/audio/speech`) {
      const body = JSON.parse(opts.body);
      calls.or.push({ headers: opts.headers, body, path: new URL(u).pathname });
      return u.endsWith('/speech') ? speakReply(body) : listenReply(body);
    }
    if (u.startsWith(`${OR}/generation?`) || u === `${OR}/key`) {
      calls.orGet.push({ url: u, auth: opts.headers?.authorization });
      if (u === `${OR}/key`) return Response.json({ data: { label: 'Lumio', ...orKey } });
      const id = new URL(u).searchParams.get('id');
      return id in generations && !unrecorded.has(id) ? Response.json({ data: { id, total_cost: generations[id] } }) : Response.json({ error: { code: 404, message: 'Generation not found' } }, { status: 404 });
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
      if (path === '/v1/checkout/sessions') return Response.json(params.ui_mode === 'embedded' ? { id: 'cs_e1', client_secret: 'cs_e1_secret_abc' } : { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
      const cs = /^\/v1\/checkout\/sessions\/(\w+)$/.exec(path);
      if (cs && stripeState.sessions?.[cs[1]]) return Response.json(stripeState.sessions[cs[1]]);
      if (path === '/v1/billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.test/p_1' });
      if (path === '/v1/billing_portal/configurations') return Response.json({ data: [{ id: 'bpc_default', metadata: {} }, { id: 'bpc_lumio', metadata: { app: 'lumio' } }] });
      const sub = /^\/v1\/subscriptions\/(\w+)$/.exec(path);
      if (sub && stripeState.subscriptions[sub[1]] && opts.method === 'POST') {
        // Switch, cancel or resume, like Stripe would.
        if (stripeState.decline && params.payment_behavior === 'error_if_incomplete') return Response.json({ error: { type: 'card_error', message: 'Your card was declined.' } }, { status: 402 });
        const s = structuredClone(stripeState.subscriptions[sub[1]]);
        if (params['items[0][price]']) s.items.data[0].price = { id: params['items[0][price]'], lookup_key: `lumio_${params['items[0][price]'].replace('price_', '')}_monthly` };
        if ('cancel_at_period_end' in params) s.cancel_at_period_end = params.cancel_at_period_end === 'true';
        if (params['cancellation_details[feedback]']) s.cancellation_details = { feedback: params['cancellation_details[feedback]'], comment: params['cancellation_details[comment]'] || null };
        stripeState.subscriptions[sub[1]] = s;
        return Response.json(s);
      }
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

test('Lumio’s payment page: Stripe’s form shows inside Lumio, and the plan is set without waiting for the webhook', async () => {
  const { token } = await signIn();
  // Until the publishable key is set up, it falls back to Stripe's own page.
  assert.deepEqual(await (await call('/api/billing/checkout', { cookie: token, method: 'POST', body: { plan: 'plus', embedded: true } })).json(), { url: 'https://checkout.stripe.test/cs_1' });
  env.STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
  const res = await call('/api/billing/checkout', { cookie: token, method: 'POST', body: { plan: 'pro', embedded: true, app: true } });
  assert.deepEqual(await res.json(), { clientSecret: 'cs_e1_secret_abc', publishableKey: 'pk_test_123' });
  const p = calls.stripe.filter((c) => c.path === '/v1/checkout/sessions').at(-1).params;
  assert.equal(p.ui_mode, 'embedded');
  assert.equal(p.return_url, `${SITE}/checkout?session_id={CHECKOUT_SESSION_ID}&app=1`);
  assert.equal(p['line_items[0][price]'], 'price_pro');
  assert.equal(p['metadata[user_id]'], userRow().id);
  assert.equal(p.success_url, undefined, 'no trip to Stripe’s page');
  // Back on Lumio's page: the plan is set right away.
  stripeState.subscriptions.sub_9 = { id: 'sub_9', customer: 'cus_1', status: 'active', metadata: { app: 'lumio', user_id: userRow().id }, items: { data: [{ id: 'si_9', price: { id: 'price_pro', lookup_key: 'lumio_pro_monthly' }, current_period_end: 1893456000 }] } };
  stripeState.sessions = { cs_e1: { id: 'cs_e1', status: 'complete', subscription: 'sub_9', metadata: { app: 'lumio', user_id: userRow().id } }, cs_other: { id: 'cs_other', status: 'complete', subscription: 'sub_9', metadata: { app: 'lumio', user_id: 'u_someone_else' } } };
  assert.deepEqual(await (await call('/api/billing/checkout-status?session_id=cs_e1', { cookie: token })).json(), { status: 'complete', plan: 'pro', planName: 'Pro' });
  assert.deepEqual([userRow().plan, userRow().plan_status, userRow().subscription_id], ['pro', 'active', 'sub_9']);
  assert.equal((await call('/api/billing/checkout-status?session_id=cs_other', { cookie: token })).status, 404, 'someone else’s checkout');
  // Already subscribed: switch plans instead of paying twice.
  const again = await call('/api/billing/checkout', { cookie: token, method: 'POST', body: { plan: 'max', embedded: true } });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'already_subscribed');
});

test('managing the plan in Lumio: see it, switch in place, cancel with a reason, resume', async () => {
  const { token } = await signIn();
  const free = await (await call('/api/billing/subscription', { token })).json();
  assert.equal(free.subscription, null);
  assert.deepEqual(free.plans.map((p) => [p.id, p.price]), [['plus', 20], ['pro', 100], ['max', 200]]);
  assert.ok(free.reasons.some((r) => r.id === 'too_expensive' && r.label === 'It costs too much'));

  sql.prepare("UPDATE users SET plan = 'plus', plan_status = 'active', subscription_id = 'sub_1', stripe_customer_id = 'cus_1'").run();
  stripeState.subscriptions.sub_1 = { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { app: 'lumio', user_id: userRow().id },
    items: { data: [{ id: 'si_1', price: { id: 'price_plus', lookup_key: 'lumio_plus_monthly' }, current_period_end: 1893456000 }] },
    default_payment_method: { card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } } };
  const mine = await (await call('/api/billing/subscription', { token })).json();
  assert.deepEqual(mine.subscription, { status: 'active', canceling: false, periodEnd: 1893456000000, price: 20, card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 } });

  // Upgrade: pay the difference now; the plan changes right away.
  assert.deepEqual(await (await call('/api/billing/change', { token, method: 'POST', body: { plan: 'pro' } })).json(), { ok: true, plan: 'pro' });
  const up = calls.stripe.filter((c) => c.path === '/v1/subscriptions/sub_1' && c.method === 'POST').at(-1).params;
  assert.deepEqual([up['items[0][id]'], up['items[0][price]'], up.proration_behavior, up.payment_behavior, up.cancel_at_period_end], ['si_1', 'price_pro', 'always_invoice', 'error_if_incomplete', 'false']);
  assert.equal(userRow().plan, 'pro');
  // A declined card changes nothing.
  stripeState.decline = true;
  const declined = await call('/api/billing/change', { token, method: 'POST', body: { plan: 'max' } });
  assert.equal(declined.status, 402);
  assert.deepEqual(await declined.json(), { error: 'Your card was declined. Nothing changed.', code: 'card_declined' });
  assert.equal(userRow().plan, 'pro');
  stripeState.decline = false;
  // Downgrade: credit for the unused part, no charge now.
  await call('/api/billing/change', { token, method: 'POST', body: { plan: 'plus' } });
  const down = calls.stripe.filter((c) => c.path === '/v1/subscriptions/sub_1' && c.method === 'POST').at(-1).params;
  assert.deepEqual([down.proration_behavior, down.payment_behavior], ['create_prorations', undefined]);
  assert.equal(userRow().plan, 'plus');
  assert.equal((await call('/api/billing/change', { token, method: 'POST', body: { plan: 'plus' } })).status, 400, 'already on it');

  // Cancel: a reason is required; it goes to Stripe and to the owner's list.
  assert.equal((await call('/api/billing/cancel', { token, method: 'POST', body: {} })).status, 400);
  const canceled = await (await call('/api/billing/cancel', { token, method: 'POST', body: { reason: 'too_expensive', comment: '  Great app, just over my budget.  ' } })).json();
  assert.deepEqual(canceled, { ok: true, endsAt: 1893456000000 });
  const c = calls.stripe.filter((x) => x.path === '/v1/subscriptions/sub_1' && x.method === 'POST').at(-1).params;
  assert.deepEqual([c.cancel_at_period_end, c['cancellation_details[feedback]'], c['cancellation_details[comment]']], ['true', 'too_expensive', 'Great app, just over my budget.']);
  assert.deepEqual([userRow().plan, userRow().plan_status], ['plus', 'canceling'], 'keeps Plus until the period ends');
  assert.equal((await (await call('/api/billing/subscription', { token })).json()).subscription.canceling, true);
  sql.prepare("UPDATE users SET role = 'owner'").run();
  const spend = await (await call('/api/admin/spend', { token })).json();
  assert.deepEqual(spend.cancellations.last30Days, [{ reason: 'too_expensive', label: 'It costs too much', n: 1 }]);
  assert.equal(spend.cancellations.recent[0].comment, 'Great app, just over my budget.');

  // Changed their mind.
  assert.deepEqual(await (await call('/api/billing/resume', { token, method: 'POST', body: {} })).json(), { ok: true, plan: 'plus' });
  assert.deepEqual([userRow().plan, userRow().plan_status], ['plus', 'active']);
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
  sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('old', ?, 'free', 'chat', 'h', 'done', 0, 99950, ?)").run(userRow().id, Date.now() - 1000);
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
  assert.deepEqual(caps.usage.windows.map((w) => [w.id, w.limit]), [['weekly', 100000]], 'no 5-hour limit');

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

test('browser: GPT-6 Luna on every plan; if it is down, Ling answers instead of an error', async () => {
  const { token } = await signIn();
  assert.equal(BROWSER_DEFAULT, 'openai/gpt-6-luna');
  const caps = await (await call('/v1/agent', { token })).json();
  assert.equal(caps.model.id, 'openai/gpt-6-luna', 'Free gets Luna too');
  // An older browser still asking for Ling gets Luna.
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ model: 'inclusionai/ling-3.0-flash-vl' }) }));
  await settled();
  assert.equal(calls.or.at(-1).body.model, 'openai/gpt-6-luna');
  // Luna's providers are busy: the same step is answered by Ling.
  reply = (body) => (body.model === 'openai/gpt-6-luna' ? new Response('{"error":{"message":"overloaded"}}', { status: 429 }) : textReply('Answered by the backup.'));
  const ev = await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's2' }) }));
  await settled();
  assert.equal(ev.at(-1).type, 'result');
  assert.equal(ev.at(-1).message.content, 'Answered by the backup.');
  assert.deepEqual(calls.or.slice(-2).map((c) => c.body.model), ['openai/gpt-6-luna', 'inclusionai/ling-3.0-flash-vl']);
  assert.deepEqual(calls.or.at(-1).body.provider.max_price, ceiling(findModel('inclusionai/ling-3.0-flash-vl')));
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
  // Seven full readings of a big page and two screenshots: this used to be refused (413).
  const messages = [{ role: 'user', content: 'Buy the iPhone 18 Pro Max with 2TB' }];
  for (let k = 0; k < 7; k++) messages.push(...readTurn(k, page(k)));
  messages.push(...shotTurn(0), ...shotTurn(1));
  const res = await call('/v1/agent', { token, method: 'POST', body: step({ messages }) });
  assert.equal(res.status, 200);
  await events(res);
  await settled();
  // Shortened 4 at a time (the newest 3 to 6 stay whole), so earlier messages stay the same for the cache.
  for (const k of [0, 1, 2, 3]) {
    assert.ok(sent(`read_${k}`).length < 2000, `reading ${k} shortened`);
    assert.match(sent(`read_${k}`), /^Page \d: iPhone 18 Pro[\s\S]*Older page reading, shortened[\s\S]*call read_page/);
  }
  for (const k of [4, 5, 6]) assert.equal(sent(`read_${k}`), page(k), `reading ${k} whole`);
  // One more reading: nothing earlier changes.
  const before = calls.or.at(-1).body.messages;
  const more = [...messages, ...readTurn(7, page(7))];
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's2', messages: more }) }));
  await settled();
  const after = calls.or.at(-1).body.messages;
  // The provider only gives the cached-input discount when the whole previous request starts the next one.
  assert.deepEqual(after.slice(0, before.length), before, 'each step’s request starts with the whole previous one');
  assert.doesNotMatch(JSON.stringify(after), /\[Lumio Browser, not the user\]/, 'no note in the middle of a task');
  assert.equal(calls.or.at(-1).body.messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')).length, 2, 'both screenshots kept');
  // It's billed and held at a realistic size, not the old bytes-as-tokens count.
  const held = sql.prepare("SELECT held_microusd FROM steps WHERE kind = 'browser'").get().held_microusd;
  assert.ok(held < 20000, `hold ${held}`);
});

test('browser: every step starts the same (cached by the provider); the time and the tab go last', async () => {
  const { token } = await signIn();
  const at = (title, url) => ({ ...context, activeTab: { id: 3, title, url } });
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ context: at('iPhone 18 Pro', 'https://www.apple.com/shop/buy-iphone/iphone-18-pro') }) }));
  await settled();
  const first = calls.or.at(-1).body.messages;
  // Apple changes the address on every choice; the start of the request must not.
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's2', context: at('iPhone 18 Pro Max', 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-2tb') }) }));
  await settled();
  const second = calls.or.at(-1).body.messages;
  assert.equal(first[0].role, 'system');
  assert.equal(second[0].content, first[0].content, 'same instructions on every step');
  assert.doesNotMatch(first[0].content, /apple\.com|Now:|output tokens/);
  assert.match(first[0].content, /Today is \w+day, \w+ \d+, \d{4} \(America\/New_York\)\./);
  // The note rides on the person's message instead of being a turn of its own.
  assert.equal(second.length, 2);
  // Later steps of the same request don't add it again (the browser doesn't keep it), and a note the browser already wrote isn't doubled.
  const later = [{ role: 'user', content: 'Summarize this page' }, ...readTurn(0, 'Page 0')];
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's3', messages: later }) }));
  await settled();
  assert.doesNotMatch(JSON.stringify(calls.or.at(-1).body.messages), /Lumio Browser, not the user/);
  const own = 'Find a hotel\n\n[Lumio Browser, not the user] Now: Wednesday, October 1, 2026 at 2:30 PM (America/New_York). No tab is open.';
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's4', messages: [{ role: 'user', content: own }] }) }));
  await settled();
  assert.equal(calls.or.at(-1).body.messages.at(-1).content, own);
  assert.match(second.at(-1).content, /^Summarize this page\n\n\[Lumio Browser, not the user\] Now: .+\(America\/New_York\)\. The user is looking at tab 3: "iPhone 18 Pro Max" — https:\/\/www\.apple\.com\/shop\/buy-iphone\/iphone-18-pro\/6\.9-inch-display-2tb\. 1 tab\(s\) open\.$/);
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

// ---------------------------------------------------------------- spend
test('spend: each AI call is checked against OpenRouter’s record right after it ends, and usage follows it', async () => {
  const { token } = await signIn();
  const row = (kind) => ({ ...sql.prepare('SELECT cost_microusd, billed_microusd, verified_at, gen_ids FROM steps WHERE kind = ?').get(kind) });
  // OpenRouter's record says a little more than the reply reported.
  reply = () => textReply('Hello from Luna.', 0.000321, 'gen-live-1');
  generations['gen-live-1'] = 0.0004;
  await events(await call('/v1/agent', { token, method: 'POST', body: step() }));
  await settled();
  assert.deepEqual(JSON.parse(row('browser').gen_ids), ['gen-live-1'], 'OpenRouter’s ID is kept');
  assert.equal(row('browser').cost_microusd, 400, 'checked live, right after the reply');
  assert.equal(row('browser').billed_microusd, 400);
  assert.equal((await (await call('/v1/usage', { token })).json()).usage.used, 400, 'the user’s usage is OpenRouter’s number');
  assert.ok(calls.orGet.every((c) => c.auth === 'Bearer sk-or-test'));

  // Chat replies and the pictures they make are checked live too.
  reply = (body) => (body.messages.at(-1).role === 'tool' ? textReply('Here it is.') : sse([{ id: 'gen-chat-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_p', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"a red fox"}' } }] }, finish_reason: 'tool_calls' }] }, { id: 'gen-chat-1', choices: [], usage: { cost: 0.0002 } }]));
  generations['gen-chat-1'] = 0.0002;
  sql.prepare("UPDATE users SET plan = 'plus'").run();
  await events(await call('/api/chat', { cookie: token, method: 'POST', body: { text: 'draw a fox' } }));
  await settled();
  assert.deepEqual(sql.prepare("SELECT kind, billed_microusd FROM steps WHERE kind != 'browser' ORDER BY created_at, kind").all().map((r) => [r.kind, r.billed_microusd]).sort(), [['chat', 200], ['chat', 321], ['image', 9400]]);

  // OpenRouter hasn't recorded a call yet: the live check tries 3 times, then the 5-minute backup run finds it.
  sql.prepare("UPDATE users SET plan = 'free'").run();
  reply = () => textReply('Hi there.', 0.000321, 'gen-slow-1');
  unrecorded.add('gen-slow-1');
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's2' }) }));
  await settled();
  const slow = () => ({ ...sql.prepare("SELECT cost_microusd, billed_microusd, verified_at FROM steps WHERE gen_ids LIKE '%gen-slow-1%'").get() });
  assert.equal(calls.orGet.filter((c) => c.url.includes('gen-slow-1')).length, 3, 'tried 3 times');
  assert.equal(slow().verified_at, null);
  const now = Date.now();
  assert.deepEqual(await verifySpend(env, now), { checked: 0, fixed: 0 }, 'the backup waits a minute');
  unrecorded.delete('gen-slow-1');
  generations['gen-slow-1'] = 0.0005;
  assert.deepEqual(await verifySpend(env, now + 2 * 60_000), { checked: 1, fixed: 1 });
  assert.equal(slow().cost_microusd, 500);
  assert.deepEqual(await verifySpend(env, now + 3 * 60_000), { checked: 0, fixed: 0 }, 'checked once');

  // One OpenRouter never records keeps the cost the reply reported, after an hour.
  reply = () => textReply('Again.', 0.000321, 'gen-lost-1');
  unrecorded.add('gen-lost-1');
  await events(await call('/v1/agent', { token, method: 'POST', body: step({ stepId: 's3' }) }));
  await settled();
  await verifySpend(env, now + 2 * 60 * 60_000);
  const lost = { ...sql.prepare("SELECT cost_microusd, billed_microusd, verified_at FROM steps WHERE gen_ids LIKE '%gen-lost-1%'").get() };
  assert.ok(lost.verified_at > 0);
  assert.equal(lost.billed_microusd, null);
  assert.equal(lost.cost_microusd, 321);

  // The cron trigger runs the backup check.
  sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at, gen_ids) VALUES ('cron', ?, 'free', 'chat', 'h', 'done', 0, 100, ?, '[\"gen-cron-1\"]')").run(userRow().id, Date.now() - 10 * 60_000);
  generations['gen-cron-1'] = 0.000123;
  await worker.scheduled({}, env, ctx);
  await settled();
  assert.equal(sql.prepare("SELECT billed_microusd FROM steps WHERE key = 'cron'").get().billed_microusd, 123);
});

test('spend page: only the owner sees OpenRouter’s charges next to what Lumio counted', async () => {
  const { token } = await signIn();
  assert.equal((await call('/api/admin/spend')).status, 401);
  assert.equal((await call('/api/admin/spend', { token })).status, 404, 'not for other accounts');
  sql.prepare("UPDATE users SET role = 'owner'").run();
  await events(await call('/v1/agent', { token, method: 'POST', body: step() }));
  await settled();
  orKey = { usage: 12.5, usage_daily: 0.000321, usage_weekly: 0.5, usage_monthly: 2.25, limit: 50, limit_remaining: 37.5 };
  const d = await (await call('/api/admin/spend', { token })).json();
  assert.deepEqual(d.openrouter, { today: 0.000321, week: 0.5, month: 2.25, total: 12.5, limit: 50, limitRemaining: 37.5 });
  assert.deepEqual(d.lumio.today, { total: 0.000321, free: 0.000321, paid: 0, byKind: { browser: 0.000321, chat: 0, image: 0, voice: 0 }, calls: 1, checked: 1 });
  assert.deepEqual(d.people, { free: 1 });
  assert.equal(d.monthlyRevenue, 0);
  assert.deepEqual(d.freeCap, { usedToday: 0.000321, cap: 3 });
  assert.equal(d.waitingForCheck, 0, 'checked live');
  // A paying account counts toward revenue.
  sql.prepare("UPDATE users SET plan = 'plus', plan_status = 'active'").run();
  assert.equal((await (await call('/api/admin/spend', { token })).json()).monthlyRevenue, 20);
});

test('plan budgets: Plus leaves 15% profit after fees; Pro and Max are set higher; no 5-hour limit', async () => {
  // Price - 15% profit - Stripe (3.6% + $0.30) - OpenRouter's 5.5% fee, per week.
  assert.equal(weeklyBudget(20), 3.48);
  assert.equal(weeklyBudget(100), 17.67);
  assert.equal(weeklyBudget(200), 35.42);
  assert.deepEqual([PLANS.free.weekly, PLANS.plus.weekly, PLANS.pro.weekly, PLANS.max.weekly], [0.1, 3.48, 20, 40]);
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
  assert.deepEqual(plans.map((p) => p.weeklyUsd), [0.1, 3.48, 20, 40]);
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

test('voice: speech to text and reading aloud are charged to the weekly allowance', async () => {
  const { token } = await signIn();
  generations['gen-stt-test'] = 0.000014;
  generations['gen-tts-test'] = 0.00003;
  const audio = Buffer.from('fake opus audio').toString('base64');
  const heard = await call('/v1/voice/transcribe', { token, method: 'POST', body: { audio, format: 'webm', seconds: 4.2, language: 'en' } });
  assert.equal(heard.status, 200);
  assert.deepEqual(await heard.json(), { text: 'What is on this page?' });
  const stt = calls.or.find((c) => c.path?.endsWith('/transcriptions')).body;
  assert.equal(stt.model, 'openai/whisper-large-v3-turbo');
  assert.deepEqual(stt.input_audio, { data: audio, format: 'webm' });
  assert.equal(stt.language, 'en');

  const spoken = await call('/v1/voice/speak', { token, method: 'POST', body: { text: 'Here is the summary.', voice: 'af_heart' } });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await spoken.arrayBuffer()).byteLength, 6);
  const tts = calls.or.find((c) => c.path?.endsWith('/speech')).body;
  assert.equal(tts.model, 'hexgrad/kokoro-82m');
  assert.equal(tts.response_format, 'mp3');
  await settled();
  const rows = sql.prepare("SELECT status, cost_microusd, billed_microusd, gen_ids FROM steps WHERE kind = 'voice' ORDER BY created_at").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'done'));
  assert.equal(rows[0].cost_microusd, 14); // OpenRouter's reported cost
  // Reading aloud is charged at the list price (20 characters: 13 microUSD),
  // then the live check puts in what OpenRouter's record says.
  assert.equal(rows[1].cost_microusd, 30);
  assert.equal(rows[1].billed_microusd, 30);
  assert.deepEqual(JSON.parse(rows[1].gen_ids), ['gen-tts-test']);
  // Bad input is refused without calling the model.
  const before = calls.or.length;
  assert.equal((await call('/v1/voice/transcribe', { token, method: 'POST', body: { audio: 'not base64!' } })).status, 400);
  assert.equal((await call('/v1/voice/speak', { token, method: 'POST', body: { text: '' } })).status, 400);
  assert.equal(calls.or.length, before);
});

test('voice: a provider failure charges nothing, and an empty allowance refuses', async () => {
  const { token } = await signIn();
  speakReply = () => Response.json({ error: { message: 'down' } }, { status: 503 });
  const r = await call('/v1/voice/speak', { token, method: 'POST', body: { text: 'Hello' } });
  assert.ok(r.status >= 500);
  assert.equal(sql.prepare("SELECT cost_microusd FROM steps WHERE kind = 'voice'").get().cost_microusd, 0);
  sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('x', ?, 'free', 'chat', 'h', 'done', 0, 100000, ?)").run(userRow().id, Date.now() - 1000);
  const out = await call('/v1/voice/transcribe', { token, method: 'POST', body: { audio: 'AAAA', seconds: 2 } });
  assert.equal(out.status, 429);
  assert.equal((await out.json()).code, 'usage_limit');
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
