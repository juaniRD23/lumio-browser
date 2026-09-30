// Lumio Browser's AI (/v1/agent): one agent step at a time, streamed as NDJSON.
// The server owns the model, tool definitions and system prompt; the browser
// picks tools by name. Retries of the same step replay its saved result.
import {
  BROWSER_AGENT_VERSION, BROWSER_REASONING, browserAgentTools, browserInputEstimate, browserModelCatalog,
  browserSystemPrompt, validateBrowserStep, validateBrowserToolCall, type NativeToolCall,
} from './agent.ts';
import type { User } from './auth.ts';
import { complete, ndjsonStream, type Reply } from './openrouter.ts';
import { allowance, costOf, planName, reserve, settle } from './usage.ts';
import { AgentError, type Env, fail, json, sha256 } from './util.ts';

const MAX_BODY = 6_000_000;
const STEPS_PER_MINUTE = 40;

export async function capabilities(env: Env, user: User) {
  return json({
    version: BROWSER_AGENT_VERSION,
    enabled: true,
    plan: user.plan,
    planName: planName(user.plan),
    models: browserModelCatalog.map((m) => ({ id: m.id, name: m.name, minimumPlan: m.minimumPlan, available: true })),
    tools: browserAgentTools.map((t) => t.function.name),
    reasoning: { levels: BROWSER_REASONING, default: 'medium' },
    usage: await allowance(env, user.id, user.plan),
  });
}

export async function step(request: Request, env: Env, ctx: ExecutionContext, user: User): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail('This request is too large. Start a new chat.', 413, 'context_too_large');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return fail('Invalid request.', 400, 'invalid_request'); }
  const s = validateBrowserStep(body);
  const now = Date.now();

  // Retries of the same step replay its saved result instead of charging again.
  const key = await sha256(`${user.id}|${s.taskId}|${s.runId}|${s.stepId}`);
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
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM steps WHERE owner = ?1 AND created_at >= ?2').bind(user.id, now - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= STEPS_PER_MINUTE) return fail('Slow down a little: too many steps in the last minute.', 429, 'rate_limited');

  const inputTokens = browserInputEstimate(s);
  const { maxOutput } = await reserve(env, { key, owner: user.id, plan: user.plan, requestHash, kind: 'browser', inputTokens, now });
  const tools = browserAgentTools.filter((t) => s.tools.includes(t.function.name));
  const gen = complete(env, {
    model: browserModelCatalog[0].id,
    messages: [{ role: 'system', content: browserSystemPrompt(s, maxOutput) }, ...s.messages],
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    max_tokens: maxOutput,
    reasoning: { effort: s.reasoning, exclude: true },
  });

  // Fail fast (with a plain error response) if the provider refuses outright.
  let first: IteratorResult<string, Reply>;
  try {
    first = await gen.next();
  } catch (err) {
    await settle(env, key, 0, 'failed');
    throw err;
  }

  const out = ndjsonStream({ version: 1, taskId: s.taskId, runId: s.runId, stepId: s.stepId });
  ctx.waitUntil((async () => {
    let reply: Reply | null = null;
    try {
      let r = first;
      while (!r.done) { await out.send({ type: 'delta', content: r.value }); r = await gen.next(); }
      reply = r.value;
      // Only tools this step offered, with arguments that match their schema.
      const toolCalls: NativeToolCall[] = reply.calls.map((c, i) => validateBrowserToolCall({
        id: c.id && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(c.id) ? c.id : `call_${i}_${crypto.randomUUID().slice(0, 8)}`,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      }, s.tools));
      for (const tool_call of toolCalls) await out.send({ type: 'tool_call', tool_call }, true);
      const u = reply.usage;
      await out.send({
        type: 'result',
        message: { role: 'assistant', content: reply.content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finishReason: toolCalls.length ? 'tool_calls' : reply.finish || 'stop',
        usage: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, total: u.total_tokens ?? 0 } : null,
      }, true);
      await settle(env, key, costOf(u, inputTokens), 'done', out.saved());
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError('Lumio AI’s reply was cut off. Try again.', 502, 'provider_error');
      await out.send({ type: 'error', code: e.code, message: e.message });
      await settle(env, key, reply?.usage ? costOf(reply.usage, inputTokens) : 0, 'failed');
    } finally {
      await out.close();
    }
  })());
  return out.response;
}
