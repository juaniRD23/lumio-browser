// Lumio Browser's AI (/v1/agent): one agent step at a time, streamed as NDJSON.
// The server owns the model, tool definitions and system prompt; the browser
// picks tools by name. Retries of the same step replay its saved result.
import {
  BROWSER_AGENT_VERSION, BROWSER_REASONING, browserAgentTools, browserInputEstimate,
  browserContextNote, browserSystemPrompt, parseToolArgs, withContextNote, ToolArgumentsError, validateBrowserStep, validateBrowserToolCall, type AgentMessage, type NativeToolCall,
} from './agent.ts';
import type { User } from './auth.ts';
import { appForTool, connectedApps, runConnectionTool, toolsFor } from './connections.ts';
import { BROWSER_BACKUP, BROWSER_DEFAULT, browserModels, canUse, findModel, publicModel } from './models.ts';
import { complete, ndjsonStream, type Reply, type Usage } from './openrouter.ts';
import { allowance, costOf, planName, reserve, settle } from './usage.ts';
import { AgentError, type Env, fail, json, sha256 } from './util.ts';

const MAX_BODY = 24_000_000; // up to 12 pictures and long attached documents
const STEPS_PER_MINUTE = 40;

export async function capabilities(env: Env, user: User) {
  const connected = toolsFor(await connectedApps(env, user.id));
  return json({
    version: BROWSER_AGENT_VERSION,
    enabled: true,
    plan: user.plan,
    planName: planName(user.plan),
    model: publicModel(findModel(BROWSER_DEFAULT)!, user.plan),
    models: browserModels().map((m) => publicModel(m, user.plan)),
    tools: [...browserAgentTools, ...connected].map((t) => t.function.name),
    // Tools the browser runs by asking the server (POST /v1/tools/run): the person's connected apps.
    remoteTools: connected.map((t) => ({ name: t.function.name, app: appForTool(t.function.name)?.name || '' })),
    reasoning: { levels: BROWSER_REASONING, default: 'medium' },
    usage: await allowance(env, user.id, user.plan),
  });
}

export async function step(request: Request, env: Env, ctx: ExecutionContext, user: User): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail('This request is too large. Start a new chat.', 413, 'context_too_large');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return fail('Invalid request.', 400, 'invalid_request'); }
  const extra = toolsFor(await connectedApps(env, user.id));
  const s = validateBrowserStep(body, extra);
  const now = Date.now();
  // The browser sends the model the server listed; anything else gets the default.
  const asked = findModel(s.model);
  let model = asked?.browser && canUse(user.plan, asked) ? asked : findModel(BROWSER_DEFAULT)!;

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

  const inputTokens = browserInputEstimate(s, extra);
  const { maxOutput } = await reserve(env, { key, owner: user.id, plan: user.plan, requestHash, kind: 'browser', inputTokens, model, now });
  const tools = [...browserAgentTools, ...extra].filter((t) => s.tools.includes(t.function.name));
  const call = (messages: unknown[]) => complete(env, model, {
    messages,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    max_tokens: maxOutput,
    reasoning: { effort: s.reasoning, exclude: true },
  });
  // The unchanging start first (cached by the provider), what changes last.
  let messages: unknown[] = [{ role: 'system', content: browserSystemPrompt(s) }, ...withContextNote(s.messages, browserContextNote(s, maxOutput))];
  let gen = call(messages);

  // Fail fast (with a plain error response) if the provider refuses outright,
  // after letting the backup model answer when the main one is down or busy.
  // (The hold was sized for the pricier model, so it covers the backup.)
  let first: IteratorResult<string, Reply>;
  try {
    try {
      first = await gen.next();
    } catch (err) {
      const backup = findModel(BROWSER_BACKUP)!;
      if (!(err instanceof AgentError && err.code === 'provider_unavailable') || model.id === backup.id) throw err;
      model = backup;
      gen = call(messages);
      first = await gen.next();
    }
  } catch (err) {
    await settle(env, key, 0, 'failed');
    throw err;
  }

  const out = ndjsonStream({ version: 1, taskId: s.taskId, runId: s.runId, stepId: s.stepId });
  ctx.waitUntil((async () => {
    let cost = 0;
    const total: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let content = '';
    try {
      let r = first;
      let toolCalls: NativeToolCall[] = [];
      let finish: string | null = null;
      for (let attempt = 0; ; attempt++) {
        while (!r.done) { await out.send({ type: 'delta', content: r.value }); r = await gen.next(); }
        const reply = r.value;
        cost += costOf(reply.usage, inputTokens, model);
        total.prompt_tokens! += reply.usage?.prompt_tokens ?? 0;
        total.completion_tokens! += reply.usage?.completion_tokens ?? 0;
        total.total_tokens! += reply.usage?.total_tokens ?? 0;
        content += reply.content;
        finish = reply.finish;
        const raw: NativeToolCall[] = reply.calls.map((c, i) => ({
          id: c.id && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(c.id) ? c.id : `call_${i}_${crypto.randomUUID().slice(0, 8)}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        }));
        // Only tools this step offered, with arguments that match their schema
        // (after fixing small slips like "12" for 12).
        let bad: { index: number; error: ToolArgumentsError } | null = null;
        toolCalls = [];
        for (let i = 0; i < raw.length && !bad; i++) {
          try { toolCalls.push(validateBrowserToolCall(raw[i], s.tools, extra)); } catch (err) {
            if (err instanceof ToolArgumentsError) bad = { index: i, error: err }; else throw err;
          }
        }
        if (!bad) break;
        if (attempt >= 1) throw bad.error;
        // Tell the model what was wrong and let it try once more.
        messages = [...messages,
          { role: 'assistant', content: reply.content || null, tool_calls: raw } satisfies AgentMessage,
          ...raw.map((c, i) => ({
            role: 'tool', tool_call_id: c.id,
            content: i === bad!.index ? `Error: ${bad!.error.detail}. Call ${bad!.error.tool} again with arguments that match its parameters.` : 'Not run, because another tool call in the same message was invalid.',
          }))];
        gen = call(messages);
        r = await gen.next();
      }
      for (const tool_call of toolCalls) await out.send({ type: 'tool_call', tool_call }, true);
      await out.send({
        type: 'result',
        message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finishReason: toolCalls.length ? 'tool_calls' : finish || 'stop',
        usage: { input: total.prompt_tokens, output: total.completion_tokens, total: total.total_tokens },
      }, true);
      await settle(env, key, cost, 'done', out.saved());
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError('Lumio AI’s reply was cut off. Try again.', 502, 'provider_error');
      await out.send({ type: 'error', code: e.code, message: e.message });
      await settle(env, key, cost, 'failed');
    } finally {
      await out.close();
    }
  })());
  return out.response;
}

// POST /v1/tools/run { name, arguments }: a connected-app tool, run for Lumio Browser.
export async function runTool(request: Request, env: Env, user: User) {
  const body = await request.json<{ name?: unknown; arguments?: unknown }>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name : '';
  const definition = toolsFor(await connectedApps(env, user.id)).find((t) => t.function.name === name);
  if (!definition) return fail('That app isn’t connected. Connect it from the + menu.', 400, 'tool_not_allowed');
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM steps WHERE owner = ?1 AND created_at >= ?2").bind(user.id, Date.now() - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= STEPS_PER_MINUTE * 2) return fail('Slow down a little.', 429, 'rate_limited');
  let args: Record<string, unknown>;
  try { args = parseToolArgs(definition, typeof body?.arguments === 'string' ? body.arguments : JSON.stringify(body?.arguments ?? {})); } catch (err) {
    return fail(err instanceof AgentError ? err.message : 'Invalid arguments.', 400, 'invalid_tool_arguments');
  }
  return json({ text: await runConnectionTool(env, user.id, name, args) });
}
