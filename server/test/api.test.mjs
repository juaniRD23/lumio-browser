// Tests lumio-browser-api with D1 simulated on node:sqlite, and stand-ins for
// lumio-usa.online (account + plan) and OpenRouter (streamed replies).
// Run: npm test   (Node 24 runs the TypeScript directly)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';

const LUMIO = 'https://lumio.test';
const OR = 'https://openrouter.test/api/v1';
const PLUS = 'plus-token-0123456789abcdef';
const FREE = 'free-token-0123456789abcdef';
const accounts = { [PLUS]: { ownerId: 'account:plus', plan: 'plus' }, [FREE]: { ownerId: 'account:free', plan: 'free' } };

let sql, env, calls, reply, pending;

function d1(db) {
  return {
    prepare(query) {
      let values = [];
      const stmt = {
        bind(...args) { values = args; return stmt; },
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

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: d1(sql), OPENROUTER_API_KEY: 'sk-or-test', LUMIO_BASE: LUMIO, OPENROUTER_BASE: OR };
  calls = { lumio: 0, or: [] };
  reply = () => textReply('Hello from Luna.');
  pending = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(LUMIO)) {
      calls.lumio++;
      const token = /__Host-lumio_session=([^;]+)/.exec(opts.headers?.cookie || '')?.[1];
      const acct = accounts[token];
      if (u.endsWith('/api/account')) return Response.json(acct ? { signedIn: true, ownerId: acct.ownerId, authMethod: 'lumio' } : { signedIn: false, ownerId: 'guest:x', authMethod: 'guest' });
      if (u.endsWith('/api/usage')) return Response.json({ usage: { plan: acct?.plan || 'free' } });
    }
    if (u === `${OR}/chat/completions`) { calls.or.push({ headers: opts.headers, body: JSON.parse(opts.body) }); return reply(); }
    return new Response('nope', { status: 404 });
  };
});

const ctx = { waitUntil: (p) => pending.push(p) };
const call = (path, { token, method = 'GET', body } = {}) => worker.fetch(new Request('https://api.test' + path, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}), env, ctx);
const events = async (res) => (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const context = { platform: 'mac', computer: true, mode: 'ask', timeZone: 'America/New_York', tabCount: 1 };
const step = (extra = {}) => ({ version: 1, taskId: 'chat-1', runId: 'run-1', stepId: 's1', model: 'openai/gpt-6-luna', reasoning: 'medium', tools: ['read_page', 'click', 'update_plan'], context, messages: [{ role: 'user', content: 'Summarize this page' }], ...extra });
const settled = async () => { await Promise.all(pending); pending = []; };

test('health, and every AI route needs a Lumio sign-in', async () => {
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/v1/agent')).status, 401);
  assert.equal((await call('/v1/usage', { token: 'guest-token-0123456789' })).status, 401, 'a guest session is not an account');
  assert.equal((await call('/v1/agent', { method: 'POST', body: step() })).status, 401);
  assert.equal(calls.or.length, 0);
});

test('capabilities: one model, the server’s tools, reasoning levels and the plan’s allowance', async () => {
  const caps = await (await call('/v1/agent', { token: PLUS })).json();
  assert.equal(caps.enabled, true);
  assert.equal(caps.planName, 'Plus');
  assert.deepEqual(caps.models.map((m) => m.id), ['openai/gpt-6-luna']);
  assert.ok(caps.tools.includes('update_plan') && caps.tools.includes('computer_click'));
  assert.deepEqual(caps.reasoning, { levels: ['low', 'medium', 'high'], default: 'medium' });
  assert.deepEqual(caps.usage.windows.map((w) => [w.id, w.limit]), [['fiveHour', 535714], ['weekly', 3750000]]);
  // The session check is cached: a second request doesn't ask Lumio again.
  const before = calls.lumio;
  await call('/v1/usage', { token: PLUS });
  assert.equal(calls.lumio, before);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
  assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM sessions').all()).includes(PLUS), 'the token itself is never stored');
});

test('a step streams the reply, sends the right request to OpenRouter, and bills the real cost', async () => {
  const res = await call('/v1/agent', { token: PLUS, method: 'POST', body: step({ reasoning: 'high' }) });
  assert.equal(res.status, 200);
  const ev = await events(res);
  await settled();
  assert.deepEqual(ev.filter((e) => e.type === 'delta').map((e) => e.content).join(''), 'Hello from Luna.');
  const result = ev.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.message.content, 'Hello from Luna.');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.taskId, 'chat-1');
  const sent = calls.or[0];
  assert.equal(sent.headers.authorization, 'Bearer sk-or-test');
  assert.equal(sent.body.model, 'openai/gpt-6-luna');
  assert.deepEqual(sent.body.reasoning, { effort: 'high', exclude: true });
  assert.deepEqual(sent.body.provider.max_price, { prompt: 0.1, completion: 0.5 });
  assert.equal(sent.body.messages[0].role, 'system');
  assert.match(sent.body.messages[0].content, /You are Lumio/);
  assert.deepEqual(sent.body.tools.map((t) => t.function.name), ['read_page', 'click', 'update_plan']);
  const row = sql.prepare('SELECT status, cost_microusd FROM steps').get();
  assert.deepEqual({ ...row }, { status: 'done', cost_microusd: 321 });
  const usage = (await (await call('/v1/usage', { token: PLUS })).json()).usage;
  assert.equal(usage.windows.find((w) => w.id === 'weekly').used, 321);
});

test('tool calls are assembled from the stream; tools the step didn’t offer are refused', async () => {
  reply = () => sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'click', arguments: '{"re' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'f":12}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 20, total_tokens: 3020, cost: 0.0002 } },
  ]);
  let ev = await events(await call('/v1/agent', { token: PLUS, method: 'POST', body: step() }));
  await settled();
  assert.deepEqual(ev.find((e) => e.type === 'tool_call').tool_call, { id: 'call_a', type: 'function', function: { name: 'click', arguments: '{"ref":12}' } });
  assert.equal(ev.at(-1).finishReason, 'tool_calls');
  assert.equal(ev.at(-1).message.tool_calls.length, 1);

  reply = () => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'run_shell', arguments: '{"command":"rm -rf ~","explanation":"x"}' } }] }, finish_reason: 'tool_calls' }] }]);
  ev = await events(await call('/v1/agent', { token: PLUS, method: 'POST', body: step({ stepId: 's2' }) }));
  await settled();
  assert.equal(ev.at(-1).type, 'error');
  assert.equal(ev.at(-1).code, 'tool_not_allowed');
  assert.ok(!ev.some((e) => e.type === 'tool_call'));
});

test('a retried step replays its result without charging again; different content is refused', async () => {
  const first = await events(await call('/v1/agent', { token: PLUS, method: 'POST', body: step() }));
  await settled();
  const again = await call('/v1/agent', { token: PLUS, method: 'POST', body: step() });
  assert.equal(again.headers.get('x-lumio-step-replayed'), 'true');
  assert.deepEqual((await events(again)).at(-1), first.at(-1));
  assert.equal(calls.or.length, 1);
  assert.equal((await call('/v1/agent', { token: PLUS, method: 'POST', body: step({ messages: [{ role: 'user', content: 'something else' }] }) })).status, 409);
});

test('Free gets a small allowance; out of it, the step is refused with usage_limit', async () => {
  const caps = await (await call('/v1/agent', { token: FREE })).json();
  assert.deepEqual(caps.usage.windows.map((w) => [w.id, w.limit]), [['fiveHour', 7142], ['weekly', 50000]]);
  const ok = await call('/v1/agent', { token: FREE, method: 'POST', body: step() });
  assert.equal(ok.status, 200);
  await ok.text(); // the browser reads the stream to the end
  await settled();
  // Pretend the week's allowance is nearly gone.
  sql.prepare("INSERT INTO steps (key, owner, plan, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('old', 'account:free', 'free', 'h', 'done', 0, 7000, ?)").run(Date.now() - 1000);
  const res = await call('/v1/agent', { token: FREE, method: 'POST', body: step({ stepId: 's2' }) });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.code, 'usage_limit');
  assert.match(body.error, /Free plan[\s\S]*Upgrade/);
  assert.equal(calls.or.length, 1, 'no model call when out of allowance');
});

test('all Free accounts together stay under the daily cap', async () => {
  env.FREE_DAILY_CAP_USD = '0.001';
  sql.prepare("INSERT INTO steps (key, owner, plan, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('other', 'account:someone', 'free', 'h', 'done', 0, 1000, ?)").run(Date.now() - 1000);
  const res = await call('/v1/agent', { token: FREE, method: 'POST', body: step() });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /capacity for Free accounts/);
  const paid = await call('/v1/agent', { token: PLUS, method: 'POST', body: step() });
  assert.equal(paid.status, 200, 'paid plans are not affected');
  await paid.text();
  await settled();
});

test('bad requests are refused before reaching the model', async () => {
  for (const bad of [step({ model: 'anthropic/claude-opus-5.5' }), step({ reasoning: 'extreme' }), step({ tools: ['write_file'] }), step({ messages: [] }), { nope: true }]) {
    const res = await call('/v1/agent', { token: PLUS, method: 'POST', body: bad });
    assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(calls.or.length, 0);
});

test('a provider failure charges nothing and can be retried', async () => {
  reply = () => new Response('{"error":{"message":"overloaded"}}', { status: 429 });
  const res = await call('/v1/agent', { token: PLUS, method: 'POST', body: step() });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'provider_unavailable');
  assert.deepEqual({ ...sql.prepare('SELECT status, cost_microusd FROM steps').get() }, { status: 'failed', cost_microusd: 0 });
  reply = () => textReply('Back again.');
  const ok = await events(await call('/v1/agent', { token: PLUS, method: 'POST', body: step() }));
  await settled();
  assert.equal(ok.at(-1).message.content, 'Back again.');
});
