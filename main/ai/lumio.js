// Runs the AI panel on the person's Lumio plan through lumio-usa.online's
// /api/browser/agent. Each model call is one "step" (task = chat, run = one
// send, step = counter). The server owns the system prompt and tool
// definitions; we send the conversation, the tool names we can run, and a
// little context. Replies stream back as NDJSON events. Retrying the same
// step ID replays its saved result instead of charging again.
const MAX_MESSAGES = 150;

// Server-side limit: at most 160 messages, starting with a real user message.
function trimForServer(messages) {
  let out = messages;
  if (out.length > MAX_MESSAGES) out = out.slice(out.length - MAX_MESSAGES);
  let start = 0;
  while (start < out.length && !(out[start].role === 'user')) start++;
  return out.slice(start);
}

// Out of allowance: the panel offers an Upgrade button for these.
function limitError(message) {
  return Object.assign(new Error(message), { code: 'usage_limit' });
}

function friendly(status, data) {
  const code = data?.code;
  if (status === 401 || code === 'sign_in_required') return 'Sign in to Lumio again (account button, top right).';
  if (code === 'browser_plan_required' || code === 'model_plan_required') return data?.error || 'Lumio AI isn’t available on your plan.';
  if (code === 'usage_limit' || status === 429) return data?.error || 'You’ve used your Lumio allowance for now. Upgrade for more, or try again when it resets.';
  if (status === 428) return 'Accept Lumio’s Terms & Conditions on lumio-usa.online, then try again.';
  if (status === 413) return 'This chat got too long. Start a new chat.';
  return data?.error || `Lumio couldn’t answer (HTTP ${status}).`;
}

async function* lumioChat({ account, model, reasoning = 'medium', messages, tools, signal, context, ids }) {
  const body = {
    version: 1,
    taskId: ids.taskId,
    runId: ids.runId,
    stepId: ids.stepId,
    model,
    reasoning,
    tools: tools.map((t) => t.function?.name || t.name),
    context,
    messages: trimForServer(messages.filter((m) => m.role !== 'system')),
  };
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await account.fetch(account.url('/api/browser/agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: account.cookie() },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      if (signal?.aborted) { const e = new Error('Stopped'); e.name = 'AbortError'; throw e; }
      if (attempt++ < 1) continue; // a dropped connection: the same step ID recovers its result
      throw new Error("Couldn't reach Lumio. Check your internet connection.");
    }
    if (res.status === 409 && attempt++ < 5) { await new Promise((r) => setTimeout(r, 2000)); continue; } // step still running
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (res.status === 401) account.refresh().catch(() => {});
      if (res.status === 429 || data?.code === 'usage_limit') throw limitError(friendly(429, data));
      throw new Error(friendly(res.status, data));
    }
    let content = '';
    let result = null;
    const calls = [];
    let buffer = '';
    const decoder = new TextDecoder();
    const handle = function* (line) {
      if (!line.trim()) return;
      const ev = JSON.parse(line);
      if (ev.type === 'delta' && typeof ev.content === 'string') { content += ev.content; yield { type: 'text', text: ev.content }; }
      else if (ev.type === 'tool_call' && ev.tool_call) calls.push(ev.tool_call);
      else if (ev.type === 'result') result = ev;
      else if (ev.type === 'error') throw (ev.code === 'usage_limit' ? limitError(friendly(429, { error: ev.message })) : new Error(ev.message || 'Lumio couldn’t finish this step.'));
    };
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          yield* handle(line);
        }
      }
      yield* handle(buffer + decoder.decode());
    } catch (err) {
      if (signal?.aborted) { const e = new Error('Stopped'); e.name = 'AbortError'; throw e; }
      throw err;
    }
    if (!result) throw new Error('Lumio’s reply ended early. Try again.');
    const final = result.message || {};
    const toolCalls = (final.tool_calls || calls).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    account.refresh().catch(() => {}); // keep the plan meter fresh
    return { content: final.content ?? content, toolCalls, finishReason: result.finishReason, usage: result.usage };
  }
}

// Which models the plan allows (from GET /api/browser/agent).
async function lumioCapabilities(account) {
  const res = await account.fetch(account.url('/api/browser/agent'), { headers: { Cookie: account.cookie() }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return data;
}

module.exports = { lumioChat, lumioCapabilities, trimForServer };
