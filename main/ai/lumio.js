// Runs the AI panel on the person's Lumio plan through the Lumio server's
// /v1/agent (server/ in this repo), authenticated with the Lumio session. Each model
// call is one "step" (task = chat, run = one send, step = counter). The server
// owns the model, system prompt and tool definitions; we send the
// conversation, the tool names we can run, the reasoning level and a little
// context. Replies stream back as NDJSON events. Retrying the same step ID
// replays its saved result instead of charging again.

// A long run sends at most this many messages, however many steps it takes.
const MAX_MESSAGES = 150;
// Its oldest steps go 50 messages at a time, so what's sent starts the same
// way for many steps in a row (the model provider's cached-input discount
// needs that).
const TRIM_BATCH = 50;
const KEEP_ASKED = 4; // the person's messages kept from before that (asked())
// "Slow down" (too many steps in a minute): wait 10 s and try again, up to 12 times.
const SLOW_DOWN_MS = 10_000;
const MAX_SLOW_DOWNS = 12;

// What the person asked (not screenshots the tools sent back as user
// messages, or notes from Lumio Browser like a site's tips).
const isRequest = (m) => m.role === 'user' && !(Array.isArray(m.content) && /^Screenshot\(s\) from the tool call/.test(m.content[0]?.text || ''))
  && !(typeof m.content === 'string' && m.content.startsWith('[Lumio Browser, not the user]'));

// The person's newest message and the ones it carries on from: a "continue"
// after Lumio stopped, or a message sent while it worked, goes back to the
// one before, until a message Lumio had finished answering. The first (the
// task) and the newest 3, oldest first, as indexes.
function asked(messages) {
  const chain = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isRequest(messages[i])) continue;
    chain.unshift(i);
    if (i === 0 || messages[i - 1].role === 'assistant') break;
  }
  return chain.length > KEEP_ASKED ? [chain[0], ...chain.slice(1 - KEEP_ASKED)] : chain;
}

// Server-side limit: at most 160 messages, starting with a real user message.
// A run longer than that drops its oldest steps but keeps what the person
// asked (asked()), so Lumio doesn't forget the task.
function trimForServer(messages) {
  let out = messages;
  if (out.length > MAX_MESSAGES) {
    let k = Math.ceil((out.length - MAX_MESSAGES + KEEP_ASKED) / TRIM_BATCH) * TRIM_BATCH;
    while (k < out.length && out[k].role !== 'assistant') k++; // start at a model turn, with its results
    out = [...asked(out).filter((i) => i < k).map((i) => out[i]), ...out.slice(k)];
  }
  let start = 0;
  while (start < out.length && !(out[start].role === 'user')) start++;
  return out.slice(start);
}

// Waits, unless Stop is pressed meanwhile.
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); const e = new Error('Stopped'); e.name = 'AbortError'; reject(e); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  });
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
  if (status === 413) return data?.error || 'This is more than Lumio can read at once. Start a new chat.';
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
  let slowed = 0;
  for (;;) {
    let res;
    try {
      res = await account.fetch(`${account.aiBase}/v1/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token()}` },
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
      // Too many steps in the last minute (Lumio and its helpers at once):
      // wait it out, a long task doesn't end over it. Not the allowance.
      if (data?.code === 'rate_limited') {
        if (slowed++ < MAX_SLOW_DOWNS) { await pause(SLOW_DOWN_MS, signal); continue; }
        throw new Error(friendly(res.status, data));
      }
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
  const res = await account.fetch(`${account.aiBase}/v1/agent`, { headers: { Authorization: `Bearer ${account.token()}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return data;
}

// Voice mode: speech to text (POST /v1/voice/transcribe) and reading a reply
// aloud (POST /v1/voice/speak, MP3 back). Both use the person's weekly allowance.
async function lumioVoice(account, kind, body) {
  if (!account?.token()) return { error: 'Sign in to Lumio first (account button, top right).' };
  let res;
  try {
    res = await account.fetch(`${account.aiBase}/v1/voice/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token()}` },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    return { error: 'Couldn’t reach Lumio. Check your connection.' };
  }
  if (res.ok && kind === 'speak') return { audio: new Uint8Array(await res.arrayBuffer()) };
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) return { error: friendly(res.status, data), code: data?.code || null };
  return { text: String(data?.text || '') };
}

module.exports = { lumioChat, lumioCapabilities, lumioVoice, trimForServer };
