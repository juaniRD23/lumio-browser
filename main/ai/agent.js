// The agent loop: model call -> tool calls (with approval) -> results -> repeat.
// Messages use the OpenAI/OpenRouter chat format. `chat` is injected so tests
// can drive the loop with a fake model.
const { needsApproval } = require('./policy');

const MAX_STEPS = 30;
const KEEP_IMAGES = 2;
const MAX_TOOL_TEXT = 24_000;

function abortError() {
  const e = new Error('Stopped');
  e.name = 'AbortError';
  return e;
}

// Only the newest screenshots are sent back to the model; older ones become a
// short placeholder so long tasks don't blow up the context window.
function prepareMessages(system, messages, keepImages = KEEP_IMAGES) {
  let seen = 0;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) { out.unshift(m); continue; }
    const parts = [];
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j];
      if (p.type === 'image_url' && ++seen > keepImages) { parts.unshift({ type: 'text', text: '[older screenshot removed]' }); continue; }
      parts.unshift(p);
    }
    out.unshift({ ...m, content: parts });
  }
  return [{ role: 'system', content: system }, ...out];
}

function toolSchemas(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

async function runToolCall(call, env) {
  const { byName, ctx, approve, getMode, emit, signal, grants } = env;
  const tool = byName.get(call.name);
  if (!tool) {
    emit({ type: 'step', id: call.id, name: call.name, label: call.name, icon: 'app', risk: 'read' });
    emit({ type: 'step_done', id: call.id, status: 'error', summary: 'Unknown tool' });
    return { text: `Error: there is no tool named "${call.name}".` };
  }
  let args;
  try {
    args = call.arguments && call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    emit({ type: 'step', id: call.id, name: tool.name, label: tool.name, icon: tool.icon, risk: 'read' });
    emit({ type: 'step_done', id: call.id, status: 'error', summary: 'Bad arguments' });
    return { text: `Error: the arguments were not valid JSON: ${String(call.arguments).slice(0, 300)}` };
  }

  const label = safe(() => tool.label(args, ctx)) || tool.name;
  const risk = typeof tool.risk === 'function' ? tool.risk(args, ctx) : tool.risk;
  emit({ type: 'step', id: call.id, name: tool.name, label, icon: tool.icon, risk });

  if (needsApproval(risk, getMode()) && !grants.has(tool.name)) {
    const detail = tool.detail ? safe(() => tool.detail(args, ctx)) : null;
    emit({ type: 'approval', id: call.id, name: tool.name, label, detail, risk });
    const decision = await approve(call.id);
    emit({ type: 'approval_done', id: call.id, decision });
    if (decision === 'stop' || signal?.aborted) throw abortError();
    if (decision === 'deny') {
      emit({ type: 'step_done', id: call.id, status: 'denied' });
      return { text: 'The user denied this action. Do not retry it. Explain what you were trying to do, or ask the user how they want to proceed.' };
    }
    if (decision === 'task') grants.add(tool.name);
  }

  try {
    const out = await tool.run(args, ctx);
    const res = typeof out === 'string' ? { text: out } : out || { text: 'Done.' };
    if (res.text && res.text.length > MAX_TOOL_TEXT) res.text = res.text.slice(0, MAX_TOOL_TEXT) + '\n…[truncated]';
    emit({ type: 'step_done', id: call.id, status: res.status || 'ok', summary: res.summary, thumb: res.thumb });
    return res;
  } catch (err) {
    if (signal?.aborted) throw abortError();
    emit({ type: 'step_done', id: call.id, status: 'error', summary: err.message });
    return { text: `Error: ${err.message}` };
  }
}

async function runAgent({
  model, messages, tools, systemPrompt, chat, approve, getMode, emit, signal, ctx,
  maxSteps = MAX_STEPS, grants = new Set(),
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const schemas = toolSchemas(tools);
  const env = { byName, ctx, approve, getMode, emit, signal, grants };

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw abortError();
    emit({ type: 'thinking' });
    const gen = chat({ model, messages: prepareMessages(systemPrompt(), messages), tools: schemas, signal });
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
      if (value.type === 'text') emit({ type: 'text', delta: value.text });
    }

    const calls = result.toolCalls || [];
    const assistant = { role: 'assistant', content: result.content || (calls.length ? null : '(no reply)') };
    if (calls.length) {
      assistant.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
    }
    messages.push(assistant);
    if (result.content) emit({ type: 'text_end' });

    if (!calls.length) {
      emit({ type: 'done', reason: result.finishReason === 'length' ? 'length' : 'complete' });
      return { steps: step + 1 };
    }

    const images = [];
    for (const call of calls) {
      const out = await runToolCall(call, env);
      messages.push({ role: 'tool', tool_call_id: call.id, content: out.text || 'Done.' });
      if (out.image) images.push(out.image);
    }
    if (images.length) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Screenshot(s) from the tool call(s) above (this is tool output, not a message from the user):' },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
    }
  }
  emit({ type: 'done', reason: 'max_steps' });
  return { steps: maxSteps };
}

// After a stop or crash mid-turn, every tool call must still have a result or
// the next request is rejected. Fill any gaps.
function repairHistory(messages, note = 'Stopped by the user before this ran.') {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const answered = new Set();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') { answered.add(messages[j].tool_call_id); j++; }
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    if (missing.length) {
      messages.splice(j, 0, ...missing.map((c) => ({ role: 'tool', tool_call_id: c.id, content: note })));
      i = j + missing.length - 1;
    }
  }
  return messages;
}

module.exports = { runAgent, prepareMessages, toolSchemas, abortError, repairHistory, MAX_STEPS };
