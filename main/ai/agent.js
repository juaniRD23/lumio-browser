// The agent loop: model call -> tool calls (with approval) -> results -> repeat.
// Messages use the OpenAI/OpenRouter chat format. `chat` is injected so tests
// can drive the loop with a fake model.
const { needsApproval } = require('./policy');

const MAX_STEPS = 100;
// After these, the next turn weighs what came back (research, other tabs,
// helpers' reports): it thinks at the chosen effort, not the quick one.
const THINK_AFTER = new Set(['web_search', 'read_url', 'list_tabs', 'send_helpers', 'save_site_tip']);
const KEEP_IMAGES = 2;
const SHOT_BATCH = 4;
const MAX_TOOL_TEXT = 24_000;

function abortError() {
  const e = new Error('Stopped');
  e.name = 'AbortError';
  return e;
}

// Only the newest screenshots are sent back to the model; older ones become a
// short placeholder so long tasks don't blow up the context window. They're
// dropped 4 at a time (2 to 5 stay), so earlier messages don't change on
// every step: the model provider only gives the cached-input discount (about
// 10x cheaper) when each request starts with the whole previous one.
// Pictures the person attached are kept (the newest 10).
const isScreenshots = (m) => m.role === 'user' && Array.isArray(m.content) && /^Screenshot\(s\) from the tool call/.test(m.content[0]?.text || '');
function prepareMessages(system, messages, keepImages = KEEP_IMAGES, keepAttached = 10) {
  const out = messages.slice();
  // Attached pictures: the newest 10.
  let attached = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!Array.isArray(m.content) || isScreenshots(m)) continue;
    const parts = [];
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j];
      parts.unshift(p.type === 'image_url' && ++attached > keepAttached ? { type: 'text', text: '[older attached picture removed]' } : p);
    }
    out[i] = { ...m, content: parts };
  }
  // Screenshots: the oldest go in batches.
  const shots = out.reduce((n, m) => n + (isScreenshots(m) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0);
  let drop = shots <= keepImages ? 0 : Math.floor((shots - keepImages) / SHOT_BATCH) * SHOT_BATCH;
  for (let i = 0; i < out.length && drop > 0; i++) {
    const m = out[i];
    if (!isScreenshots(m)) continue;
    out[i] = { ...m, content: m.content.map((p) => (p.type === 'image_url' && drop > 0 && drop-- ? { type: 'text', text: '[older screenshot removed]' } : p)) };
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
  // Quiet tools (the plan checklist) show up in their own UI, not as step chips.
  const chip = tool.quiet ? () => {} : emit;
  let args;
  try {
    args = call.arguments && call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    chip({ type: 'step', id: call.id, name: tool.name, label: tool.name, icon: tool.icon, risk: 'read' });
    chip({ type: 'step_done', id: call.id, status: 'error', summary: 'Bad arguments' });
    return { text: `Error: the arguments were not valid JSON: ${String(call.arguments).slice(0, 300)}` };
  }

  const label = safe(() => tool.label(args, ctx)) || tool.name;
  const risk = typeof tool.risk === 'function' ? tool.risk(args, ctx) : tool.risk;
  chip({ type: 'step', id: call.id, name: tool.name, label, icon: tool.icon, risk });

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

  safe(() => ctx?.onToolRun?.(tool, args, label)); // e.g. the screen glow when it controls the computer
  try {
    if (ctx) ctx.callId = call.id; // which step is running (send_helpers groups its helpers under it)
    const out = await tool.run(args, ctx);
    const res = typeof out === 'string' ? { text: out } : out || { text: 'Done.' };
    if (res.text && res.text.length > MAX_TOOL_TEXT) res.text = res.text.slice(0, MAX_TOOL_TEXT) + '\n…[truncated]';
    chip({ type: 'step_done', id: call.id, status: res.status || 'ok', summary: res.summary, thumb: res.thumb });
    return res;
  } catch (err) {
    if (signal?.aborted) throw abortError();
    chip({ type: 'step_done', id: call.id, status: 'error', summary: err.message });
    return { text: `Error: ${err.message}` };
  }
}

async function runAgent({
  model, messages, tools, systemPrompt, chat, approve, getMode, emit, signal, ctx,
  maxSteps = MAX_STEPS, grants = new Set(), takeQueued = null,
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Messages the person sent (typed or said) while Lumio was working join the
  // conversation before the next step, so it can change course.
  const absorb = () => {
    const queued = takeQueued?.() || [];
    for (const content of queued) messages.push({ role: 'user', content });
    return queued.length;
  };
  const schemas = toolSchemas(tools);
  const env = { byName, ctx, approve, getMode, emit, signal, grants };
  // Where the time goes: the model thinking and answering, or the actions.
  const started = Date.now();
  let modelMs = 0;
  let toolMs = 0;
  const timing = (steps) => ({ ms: Date.now() - started, modelMs, toolMs, steps });
  // Tips saved for the site in front of it, before it starts.
  const intro = ctx?.siteTips?.();
  if (intro) messages.push({ role: 'user', content: intro });
  // The first turn plans at the chosen effort; routine turns after it (click,
  // type, scroll…) think less, which is most of the speed. Anything that
  // needs judgment (an error, a new message, research results, every 10th
  // step) gets the full effort again.
  let quick = false;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw abortError();
    emit({ type: 'thinking' });
    const modelStart = Date.now();
    const gen = chat({ model, messages: prepareMessages(systemPrompt(), messages), tools: schemas, signal, quick });
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
      if (value.type === 'text') emit({ type: 'text', delta: value.text });
    }
    modelMs += Date.now() - modelStart;

    const calls = result.toolCalls || [];
    const assistant = { role: 'assistant', content: result.content || (calls.length ? null : '(no reply)') };
    if (calls.length) {
      assistant.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
    }
    messages.push(assistant);
    if (result.content) emit({ type: 'text_end' });

    if (!calls.length) {
      if (absorb()) { quick = false; continue; } // they said something while it answered: answer that too
      emit({ type: 'done', reason: result.finishReason === 'length' ? 'length' : 'complete', timing: timing(step + 1) });
      return { steps: step + 1 };
    }

    const images = [];
    let trouble = false;
    for (const call of calls) {
      const toolStart = Date.now();
      const out = await runToolCall(call, env);
      toolMs += Date.now() - toolStart;
      const text = out.text || 'Done.';
      if (/^(Error|Refused)\b/.test(text) || out.status === 'blocked') trouble = true;
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      if (out.image) images.push(out.image);
    }
    // Tips saved for a site it just arrived on: added to the last result.
    const tips = ctx?.siteTips?.();
    if (tips) messages[messages.length - 1].content += `\n\n${tips}`;
    if (images.length) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Screenshot(s) from the tool call(s) above (this is tool output, not a message from the user):' },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
    }
    const heard = absorb();
    quick = !trouble && !heard && !calls.some((c) => THINK_AFTER.has(c.name)) && (step + 1) % 10 !== 0;
  }
  emit({ type: 'done', reason: 'max_steps', steps: maxSteps, timing: timing(maxSteps) });
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
