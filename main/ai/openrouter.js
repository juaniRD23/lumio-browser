// OpenRouter client: key check, model list, and streaming chat completions
// with tool-call assembly. OpenAI-compatible wire format.
const BASE = process.env.LUMIO_OPENROUTER_BASE || 'https://openrouter.ai/api/v1';

function headers(key) {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://lumio-usa.online',
    'X-Title': 'Lumio Browser',
  };
}

function friendlyError(status, body) {
  const msg = body?.error?.message || body?.message || '';
  if (status === 401) return 'OpenRouter rejected your API key. Check it in Settings.';
  if (status === 402) return 'Your OpenRouter account is out of credits. Add credits at openrouter.ai/credits.';
  if (status === 429) return 'OpenRouter is rate-limiting this model right now. Try again in a moment or pick another model.';
  if (/image/i.test(msg) && /support|endpoint/i.test(msg)) return "This model can't read images right now. Pick another model.";
  if (/tool/i.test(msg) && /support/i.test(msg)) return "This model doesn't support tools. Pick another model.";
  if (/context|too long|maximum/i.test(msg)) return 'The conversation got too long for this model. Start a new chat.';
  return msg ? `OpenRouter error: ${msg}` : `OpenRouter error (HTTP ${status}).`;
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

async function checkKey(key) {
  const res = await fetch(`${BASE}/key`, { headers: headers(key) });
  const body = await readJson(res);
  if (!res.ok) return { ok: false, error: friendlyError(res.status, body) };
  const d = body?.data || {};
  return { ok: true, label: d.label, limit: d.limit, usage: d.usage };
}

async function listModels(key) {
  const res = await fetch(`${BASE}/models?supported_parameters=tools`, { headers: key ? headers(key) : {} });
  const body = await readJson(res);
  if (!res.ok) throw new Error(friendlyError(res.status, body));
  return (body?.data || [])
    .filter((m) => !/:batch$/.test(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      vision: (m.architecture?.input_modalities || []).includes('image'),
      context: m.context_length || 0,
      prompt: Number(m.pricing?.prompt || 0) * 1e6,
      completion: Number(m.pricing?.completion || 0) * 1e6,
      created: m.created || 0,
    }));
}

// Incremental SSE parser: feed() raw text chunks, get parsed JSON payloads.
function createSSEParser() {
  let buffer = '';
  const take = (flush) => {
    const out = [];
    const lines = buffer.split('\n');
    buffer = flush ? '' : lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('data:')) continue; // comments (": OPENROUTER PROCESSING") and blanks
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') { out.push({ done: true }); continue; }
      try { out.push({ json: JSON.parse(data) }); } catch { /* partial or junk line */ }
    }
    return out;
  };
  return {
    feed(text) { buffer += text; return take(false); },
    end() { return take(true); },
  };
}

// Assembles streamed tool-call deltas (by index) into complete calls.
function createToolCallAccumulator() {
  const calls = [];
  return {
    add(deltas) {
      for (const d of deltas || []) {
        const i = d.index ?? calls.length;
        const c = calls[i] || (calls[i] = { id: '', name: '', arguments: '' });
        if (d.id) c.id = d.id;
        if (d.function?.name) c.name += d.function.name;
        if (d.function?.arguments) c.arguments += d.function.arguments;
      }
    },
    result() {
      return calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.arguments || '{}' }));
    },
  };
}

// Streams one completion. Yields {type:'text'|'reasoning', text}, and finally
// returns {content, toolCalls, finishReason, usage}.
async function* streamChat({ key, model, messages, tools, signal, maxTokens = 8192 }) {
  const body = {
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    usage: { include: true },
  };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const idle = new AbortController();
  const onAbort = () => idle.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let idleTimer = setTimeout(() => idle.abort(new Error('timeout')), 120_000);
  const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error('timeout')), 120_000); };

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(body),
      signal: idle.signal,
    });
    if (!res.ok) throw new Error(friendlyError(res.status, await readJson(res)));

    const parser = createSSEParser();
    const acc = createToolCallAccumulator();
    const decoder = new TextDecoder();
    let content = '';
    let finishReason = null;
    let usage = null;

    const handle = function* (events) {
      for (const ev of events) {
        if (ev.done || !ev.json) continue;
        const j = ev.json;
        if (j.error) throw new Error(friendlyError(j.error.code || 500, j));
        if (j.usage) usage = j.usage;
        const choice = j.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning) yield { type: 'reasoning', text: delta.reasoning };
        if (delta.content) { content += delta.content; yield { type: 'text', text: delta.content }; }
        if (delta.tool_calls) acc.add(delta.tool_calls);
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (choice.error) throw new Error(friendlyError(500, { error: choice.error }));
      }
    };

    for await (const chunk of res.body) {
      bump();
      yield* handle(parser.feed(decoder.decode(chunk, { stream: true })));
    }
    yield* handle(parser.end());
    return { content, toolCalls: acc.result(), finishReason, usage };
  } catch (err) {
    if (signal?.aborted) { const e = new Error('Stopped'); e.name = 'AbortError'; throw e; }
    if (idle.signal.aborted && idle.signal.reason?.message === 'timeout') throw new Error('The model stopped responding. Try again.');
    if (err.name === 'TypeError' && /fetch/i.test(err.message)) throw new Error("Couldn't reach OpenRouter. Check your internet connection.");
    throw err;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { checkKey, listModels, streamChat, createSSEParser, createToolCallAccumulator, friendlyError, BASE };
