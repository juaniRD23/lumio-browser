// lumio-browser-api: runs Lumio Browser's AI on the person's Lumio plan.
//
//   GET  /v1/agent   what this account can use (model, tools, reasoning levels, allowance)
//   GET  /v1/usage   the account's Lumio Browser allowance (same shape as lumio-usa.online's /api/usage)
//   POST /v1/agent   one agent step, streamed back as NDJSON
//
// The browser sends the person's Lumio session token (Authorization: Bearer).
// We check it, and read the plan, through lumio-usa.online's own account API,
// so nothing on the Lumio website has to change. Each plan gets a weekly
// allowance (and a 5-hour one below Pro), charged at the model's real cost as
// reported by OpenRouter. The model, tool definitions and system prompt belong
// to this server; the browser only picks tools by name.
import {
  AgentError, BROWSER_AGENT_VERSION, BROWSER_REASONING, browserAgentTools, browserInputEstimate, browserModelCatalog,
  browserSystemPrompt, validateBrowserStep, validateBrowserToolCall, type NativeToolCall, type Plan,
} from './agent.ts';

export interface Env {
  DB: D1Database;
  OPENROUTER_API_KEY?: string;
  LUMIO_BASE: string; // https://lumio-usa.online
  OPENROUTER_BASE?: string; // tests point this at a stand-in
  FREE_DAILY_CAP_USD?: string; // total Free-plan spend per day, across everyone
}

const MODEL = browserModelCatalog[0].id;
// Price ceiling sent to OpenRouter (2x list price), in USD per million tokens. Also used to hold budget.
const CEILING = { prompt: 0.1, completion: 0.5 };
// microUSD per token, for holds
const HOLD_RATE = { input: CEILING.prompt, output: CEILING.completion };
// Fallback when OpenRouter doesn't report a cost: list price, microUSD per token.
const LIST_RATE = { input: 0.05, output: 0.25 };
// Weekly allowance per plan in USD (the same budgets as lumio-usa.online's plans).
const WEEKLY: Record<Plan, number> = { free: 0.05, go: 2, plus: 3.75, pro: 13.75, max: 27.5 };
const PLAN_NAMES: Record<Plan, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', max: 'Max' };
const HOUR = 3600_000;
const WEEK = 7 * 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
const SESSION_TTL = 5 * 60_000; // re-check the Lumio session and plan every 5 minutes
const MAX_OUTPUT = 8192;
const MIN_OUTPUT = 1024;
const MAX_BODY = 6_000_000;
const STEPS_PER_MINUTE = 40;

type Who = { owner: string; plan: Plan };

// ---------------------------------------------------------------- helpers
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
const fail = (message: string, status: number, code: string) => json({ error: message, code }, status);

async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function limits(plan: Plan) {
  const weekly = Math.floor(WEEKLY[plan] * 1_000_000);
  return { weekly, fiveHour: plan === 'pro' || plan === 'max' ? null : Math.floor(weekly / 7) };
}

// What counts against the allowance: settled cost, or the hold while a step runs.
const SPENT = "COALESCE(SUM(CASE WHEN status='running' THEN held_microusd ELSE COALESCE(cost_microusd, held_microusd) END), 0)";

async function spent(env: Env, owner: string, since: number) {
  const row = await env.DB.prepare(`SELECT ${SPENT} AS used FROM steps WHERE owner = ?1 AND created_at >= ?2`).bind(owner, since).first<{ used: number }>();
  return row?.used ?? 0;
}

// The allowance, in the same shape lumio-usa.online's /api/usage uses.
async function allowance(env: Env, who: Who, now = Date.now()) {
  const l = limits(who.plan);
  const windows = [];
  if (l.fiveHour !== null) {
    const used = await spent(env, who.owner, now - FIVE_HOURS);
    windows.push({ id: 'fiveHour', label: '5-hour usage limit', limit: l.fiveHour, used, remaining: Math.max(0, l.fiveHour - used), resetsAt: now + FIVE_HOURS });
  }
  const used = await spent(env, who.owner, now - WEEK);
  windows.push({ id: 'weekly', label: 'Weekly usage limit', limit: l.weekly, used, remaining: Math.max(0, l.weekly - used), resetsAt: now + WEEK });
  const tightest = windows.reduce((a, b) => (a.remaining / a.limit <= b.remaining / b.limit ? a : b));
  return { ...tightest, plan: who.plan, planName: PLAN_NAMES[who.plan], windows, remaining: Math.min(...windows.map((w) => w.remaining)) };
}

// ---------------------------------------------------------------- who is asking
// Checks the Lumio session with lumio-usa.online (cached for a few minutes, by
// a hash of the token; the token itself is never stored).
async function identify(request: Request, env: Env): Promise<Who | null> {
  const token = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) return null;
  const hash = await sha256(token);
  const now = Date.now();
  const cached = await env.DB.prepare('SELECT owner, plan, checked_at FROM sessions WHERE token_hash = ?1').bind(hash).first<{ owner: string; plan: Plan; checked_at: number }>();
  if (cached && now - cached.checked_at < SESSION_TTL) return { owner: cached.owner, plan: cached.plan };
  const base = env.LUMIO_BASE.replace(/\/$/, '');
  const cookie = `${base.startsWith('https:') ? '__Host-lumio_session' : 'lumio_session'}=${token}`;
  const get = (path: string) => fetch(base + path, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' });
  let account: { signedIn?: boolean; ownerId?: string; authMethod?: string } | null = null;
  let usage: { plan?: string; usage?: { plan?: string } } | null = null;
  try {
    const [a, u] = await Promise.all([get('/api/account'), get('/api/usage')]);
    if (a.ok) account = await a.json();
    if (u.ok) usage = await u.json();
  } catch {
    // Lumio unreachable: keep using a recent check for a little longer.
    if (cached && now - cached.checked_at < 30 * 60_000) return { owner: cached.owner, plan: cached.plan };
    throw new AgentError('Couldn’t reach Lumio to check your account. Try again in a moment.', 503, 'lumio_unavailable');
  }
  if (!account?.signedIn || !account.ownerId || account.authMethod === 'guest') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run();
    return null;
  }
  const raw = usage?.usage?.plan ?? usage?.plan;
  const plan: Plan = raw && raw in WEEKLY ? (raw as Plan) : 'free';
  await env.DB.prepare('INSERT INTO sessions (token_hash, owner, plan, checked_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(token_hash) DO UPDATE SET owner = ?2, plan = ?3, checked_at = ?4')
    .bind(hash, account.ownerId, plan, now).run();
  return { owner: account.ownerId, plan };
}

// ---------------------------------------------------------------- routes
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'lumio-browser-api' });
      if (url.pathname === '/v1/agent' && request.method === 'GET') return await capabilities(request, env);
      if (url.pathname === '/v1/usage' && request.method === 'GET') {
        const who = await identify(request, env);
        if (!who) return fail('Sign in to your Lumio account.', 401, 'sign_in_required');
        return json({ usage: await allowance(env, who) });
      }
      if (url.pathname === '/v1/agent' && request.method === 'POST') return await step(request, env, ctx);
      return fail('Not found.', 404, 'not_found');
    } catch (err) {
      if (err instanceof AgentError) return fail(err.message, err.status, err.code);
      console.error('lumio-browser-api', (err as Error)?.stack || err);
      return fail('Lumio AI hit a problem. Try again.', 500, 'server_error');
    }
  },
};

async function capabilities(request: Request, env: Env) {
  const who = await identify(request, env);
  if (!who) return json({ version: BROWSER_AGENT_VERSION, enabled: false, reason: 'Sign in to your Lumio account to use Lumio AI.' }, 401);
  return json({
    version: BROWSER_AGENT_VERSION,
    enabled: true,
    plan: who.plan,
    planName: PLAN_NAMES[who.plan],
    models: browserModelCatalog.map((m) => ({ id: m.id, name: m.name, minimumPlan: m.minimumPlan, available: true })),
    tools: browserAgentTools.map((t) => t.function.name),
    reasoning: { levels: BROWSER_REASONING, default: 'medium' },
    usage: await allowance(env, who),
  });
}

async function step(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const who = await identify(request, env);
  if (!who) return fail('Sign in to your Lumio account first.', 401, 'sign_in_required');
  if (!env.OPENROUTER_API_KEY) return fail('Lumio AI isn’t connected to its model right now.', 503, 'model_not_connected');
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail('This request is too large. Start a new chat.', 413, 'context_too_large');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return fail('Invalid request.', 400, 'invalid_request'); }
  const s = validateBrowserStep(body);
  const now = Date.now();

  // Retries of the same step replay its saved result instead of charging again.
  const key = await sha256(`${who.owner}|${s.taskId}|${s.runId}|${s.stepId}`);
  const requestHash = await sha256(raw);
  const prior = await env.DB.prepare('SELECT request_hash, status, result FROM steps WHERE key = ?1').bind(key).first<{ request_hash: string; status: string; result: string | null }>();
  if (prior) {
    if (prior.request_hash !== requestHash) return fail('This step was already sent with different content.', 409, 'step_conflict');
    if (prior.status === 'running') return fail('This step is still running.', 409, 'step_running');
    if (prior.status === 'done' && prior.result) {
      return new Response(prior.result, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-lumio-step-replayed': 'true' } });
    }
    await env.DB.prepare('DELETE FROM steps WHERE key = ?1').bind(key).run(); // a failed step may be tried again
  }

  // Keep one account from flooding the model.
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM steps WHERE owner = ?1 AND created_at >= ?2').bind(who.owner, now - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= STEPS_PER_MINUTE) return fail('Slow down a little: too many steps in the last minute.', 429, 'rate_limited');

  // Free accounts share a daily cap, so free use can't run up the bill.
  if (who.plan === 'free') {
    const cap = Math.floor(Number(env.FREE_DAILY_CAP_USD || '3') * 1_000_000);
    const today = await env.DB.prepare(`SELECT ${SPENT} AS used FROM steps WHERE plan = 'free' AND created_at >= ?1`).bind(now - 24 * HOUR).first<{ used: number }>();
    if ((today?.used ?? 0) >= cap) return fail('Lumio AI is at capacity for Free accounts today. Try again later, or upgrade for more.', 429, 'usage_limit');
  }

  // Hold enough for this step's input plus its output, within what's left.
  const left = (await allowance(env, who, now)).remaining;
  const inputTokens = browserInputEstimate(s);
  const inputHold = Math.ceil(inputTokens * HOLD_RATE.input);
  const maxOutput = Math.min(MAX_OUTPUT, Math.floor((left - inputHold) / HOLD_RATE.output));
  if (maxOutput < MIN_OUTPUT) {
    const name = PLAN_NAMES[who.plan];
    return fail(`You’ve used your Lumio AI allowance on the ${name} plan for now.${who.plan === 'max' ? ' It refills over the week.' : ' Upgrade for more, or try again when it refills.'}`, 429, 'usage_limit');
  }
  const held = inputHold + Math.ceil(maxOutput * HOLD_RATE.output);
  const l = limits(who.plan);
  const reserved = await env.DB.prepare(`INSERT INTO steps (key, owner, plan, request_hash, status, held_microusd, created_at)
    SELECT ?1, ?2, ?3, ?4, 'running', ?5, ?6
    WHERE (SELECT ${SPENT} FROM steps WHERE owner = ?2 AND created_at >= ?7) + ?5 <= ?8
      AND (?9 IS NULL OR (SELECT ${SPENT} FROM steps WHERE owner = ?2 AND created_at >= ?10) + ?5 <= ?9)
    RETURNING key`).bind(key, who.owner, who.plan, requestHash, held, now, now - WEEK, l.weekly, l.fiveHour, now - FIVE_HOURS).first();
  if (!reserved) return fail(`You’ve used your Lumio AI allowance on the ${PLAN_NAMES[who.plan]} plan for now. Upgrade for more, or try again when it refills.`, 429, 'usage_limit');

  const base = (env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const tools = browserAgentTools.filter((t) => s.tools.includes(t.function.name));
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://lumio-browser.gw607953.workers.dev', 'X-Title': 'Lumio Browser' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: browserSystemPrompt(s, maxOutput) }, ...s.messages],
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
        max_tokens: maxOutput,
        reasoning: { effort: s.reasoning, exclude: true },
        provider: { max_price: CEILING, require_parameters: true, allow_fallbacks: true },
      }),
    });
  } catch {
    await settle(env, key, 0, 'failed', null);
    return fail('Couldn’t reach Lumio AI’s model. Try again.', 502, 'provider_unavailable');
  }
  if (!upstream.ok || !upstream.body) {
    await settle(env, key, 0, 'failed', null);
    const status = upstream.status === 429 ? 503 : 502;
    return fail('Lumio AI’s model is busy right now. Try again in a moment.', status, 'provider_unavailable');
  }

  // OpenRouter SSE -> NDJSON events for the browser.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const ids = { version: 1, taskId: s.taskId, runId: s.runId, stepId: s.stepId };
  const saved: string[] = [];
  const send = (e: Record<string, unknown>, keep = false) => {
    const line = JSON.stringify({ ...ids, ...e }) + '\n';
    if (keep) saved.push(line);
    return writer.write(enc.encode(line)).catch(() => {});
  };
  ctx.waitUntil((async () => {
    let content = '';
    let finish: string | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | null = null;
    const calls: { id?: string; name: string; args: string }[] = [];
    try {
      const reader = upstream.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut;
        while ((cut = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, cut).trim();
          buf = buf.slice(cut + 1);
          if (!line.startsWith('data:')) continue; // comments and keep-alives
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk: any;
          try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.error) throw new AgentError(chunk.error.message || 'The model stopped with an error.', 502, 'provider_error');
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          const d = choice.delta || {};
          if (typeof d.content === 'string' && d.content) { content += d.content; await send({ type: 'delta', content: d.content }); }
          for (const tc of d.tool_calls || []) {
            const i = tc.index ?? 0;
            calls[i] ??= { name: '', args: '' };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].name += tc.function.name;
            if (tc.function?.arguments) calls[i].args += tc.function.arguments;
          }
        }
      }
      // Only tools this step offered, with arguments that match their schema.
      const toolCalls: NativeToolCall[] = calls.filter(Boolean).map((c, i) => validateBrowserToolCall({
        id: c.id && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(c.id) ? c.id : `call_${i}_${crypto.randomUUID().slice(0, 8)}`,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      }, s.tools));
      for (const tool_call of toolCalls) await send({ type: 'tool_call', tool_call }, true);
      const cost = costOf(usage, inputTokens);
      await send({
        type: 'result',
        message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finishReason: toolCalls.length ? 'tool_calls' : finish || 'stop',
        usage: usage ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, total: usage.total_tokens ?? 0 } : null,
      }, true);
      await settle(env, key, cost, 'done', saved.join(''));
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError('Lumio AI’s reply was cut off. Try again.', 502, 'provider_error');
      await send({ type: 'error', code: e.code, message: e.message });
      await settle(env, key, usage ? costOf(usage, inputTokens) : 0, 'failed', null);
    } finally {
      await writer.close().catch(() => {});
    }
  })());
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}

// The step's real cost in microUSD: what OpenRouter reports, else list price.
function costOf(usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null, inputEstimate: number) {
  if (usage && typeof usage.cost === 'number' && usage.cost >= 0) return Math.ceil(usage.cost * 1_000_000);
  const input = usage?.prompt_tokens ?? inputEstimate;
  const output = usage?.completion_tokens ?? 0;
  return Math.ceil(input * LIST_RATE.input + output * LIST_RATE.output);
}

async function settle(env: Env, key: string, cost: number, status: 'done' | 'failed', result: string | null) {
  await env.DB.prepare('UPDATE steps SET status = ?2, cost_microusd = ?3, result = ?4 WHERE key = ?1').bind(key, status, cost, result).run();
}
