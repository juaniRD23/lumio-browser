// The agent loop: model call -> tool calls (with approval) -> results -> repeat.
// Messages use the OpenAI/OpenRouter chat format. `chat` is injected so tests
// can drive the loop with a fake model.
const crypto = require('crypto');
const { needsApproval } = require('./policy');
const { t } = require('../i18n');

// There's no step budget: a task runs until Lumio answers without tools, the
// person presses Stop, the plan's allowance runs out, or it's stuck (below).
// These ceilings only contain a bug; ordinary tasks never get near them.
const MAX_STEPS = 1000; // a task the person is watching
const UNATTENDED_STEPS = 300; // a scheduled task, running on its own
// After these, the next turn weighs what came back (research, other tabs,
// helpers' reports): it thinks at the chosen effort, not the quick one.
const THINK_AFTER = new Set(['web_search', 'read_url', 'list_tabs', 'send_helpers', 'save_site_tip']);
const KEEP_IMAGES = 2;
const SHOT_BATCH = 4;
const MAX_TOOL_TEXT = 24_000;
// The Lumio server takes at most 12 tool calls in one model turn: a turn with
// more would make every later step fail, so the extra ones don't run.
const MAX_CALLS = 12;

// Stuck: the task has stopped getting anywhere. Each step is fingerprinted
// from its tool calls, the active tab's address, what the tab shows after it
// (a short hash of its text, field values and scroll positions: a click on
// "+" or a scroll changes it even when the tool's answer is the same) and the
// results, with text that changes on its own (clock times, "5 seconds ago")
// taken out; a screenshot counts by what the tab shows, not its bytes, which
// change whenever anything moves. A step never seen before is progress; a
// repeat brings nothing new.
// - Acting (clicking, typing…) with nothing new: the same step 3 times within
//   the last 8, or 8 steps in a row that repeat earlier ones (a loop of
//   several different steps), adds a note telling the model to change course;
//   the same step 6 times within 12, or 12 in a row, ends the task.
// - Waiting on purpose (only waits and looks, or a wait at least every 4th
//   step) is counted in time, not checks: a note every 2 minutes with no
//   change (and at the 3rd look with no wait in between), and it ends after 15.
const NUDGE = { times: 3, within: 8, stale: 8 };
const GIVE_UP = { times: 6, within: 12, stale: 12 };
const WAIT_NOTE_MS = 2 * 60_000;
const WAIT_LIMIT_MS = 15 * 60_000;
const LOOKS = new Set(['read_page', 'screenshot_tab', 'list_tabs', 'read_url']);
// Text that changes on its own: clock times, "5 seconds ago", countdowns, long ids.
const VOLATILE = /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\b\.?)?|\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b|\d{10,}/gi;
const steady = (text) => String(text || '').replace(VOLATILE, '#');
// Close to the safety ceiling, the model is told to wrap up and report.
const WRAP_UP = 3;

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

const digest = (text) => crypto.createHash('sha1').update(text).digest('base64').slice(0, 12);

// The same arguments however they're written ({"a":1,"b":2} = {"b":2,"a":1}).
function sameArgs(raw) {
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  try { return JSON.stringify(sorted(JSON.parse(raw || '{}'))); } catch { return String(raw).replace(/\s+/g, ' ').trim(); }
}

// Remembers each step's fingerprint and says whether the task is stuck
// (verdict 'nudge' or 'stop'). heard() marks something new from the person
// (a message sent while it works), which starts the count again.
function stuckWatch(now = Date.now) {
  const seen = new Set(); // every step so far
  let run = []; // the newest step that brought something new, and the ones since; { key, at, waits, looks }
  const check = async (calls, results, ctx) => {
    const tab = safe(() => ctx?.tabs?.active);
    let page = '';
    try { page = (await ctx?.pageState?.(VOLATILE.source)) || ''; } catch { /* no page to look at */ }
    const names = calls.map((c) => c.name);
    const key = digest([
      ...calls.map((c) => (c.name === 'wait' ? 'wait' : `${c.name} ${sameArgs(c.arguments)}`)),
      tab?.url || '',
      page,
      ...results.map((r) => `${steady(r.text)}\n${r.sig || ''}`),
    ].join('\n'));
    const step = { key, at: now(), waits: names.includes('wait'), looks: names.every((n) => n === 'wait' || LOOKS.has(n)) };
    if (!seen.has(key)) { seen.add(key); run = [step]; return { verdict: null }; }
    run.push(step);
    const stale = run.slice(1);
    // Waiting on purpose: how long nothing has changed.
    if (stale.every((s) => s.looks) || stale.filter((s) => s.waits).length * 4 >= stale.length) {
      const quiet = step.at - run[0].at;
      const minutes = Math.round(quiet / 60_000);
      if (quiet >= WAIT_LIMIT_MS) return { verdict: 'stop', waiting: true, minutes };
      const before = run.at(-2).at - run[0].at;
      const again = stale.length === 2 && !run.some((s) => s.waits); // looking again and again without waiting
      if (again || Math.floor(quiet / WAIT_NOTE_MS) > Math.floor(before / WAIT_NOTE_MS)) return { verdict: 'nudge', waiting: true, times: run.length, minutes };
      return { verdict: null };
    }
    const repeats = (within) => run.slice(-within).filter((s) => s.key === key).length;
    if (repeats(GIVE_UP.within) >= GIVE_UP.times || stale.length >= GIVE_UP.stale) return { verdict: 'stop' };
    const n = repeats(NUDGE.within);
    if (n >= NUDGE.times) return { verdict: 'nudge', times: n };
    return stale.length >= NUDGE.stale ? { verdict: 'nudge', loop: stale.length } : { verdict: null };
  };
  check.heard = () => { run = [{ key: null, at: now(), waits: false, looks: false }]; };
  return check;
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

  // In Lumio's language: the panel shows it as is (it names things on the page).
  const label = t(safe(() => tool.label(args, ctx)) || tool.name);
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
      return { text: 'The user denied this action. Do not retry it. Explain what you were trying to do, or ask the user how they want to proceed.', label };
    }
    if (decision === 'task') grants.add(tool.name);
  }

  try {
    if (ctx) ctx.callId = call.id; // which step is running (send_helpers groups its helpers under it)
    const out = await tool.run(args, ctx);
    const res = typeof out === 'string' ? { text: out } : out || { text: 'Done.' };
    if (res.text && res.text.length > MAX_TOOL_TEXT) res.text = res.text.slice(0, MAX_TOOL_TEXT) + '\n…[truncated]';
    chip({ type: 'step_done', id: call.id, status: res.status || 'ok', summary: res.summary, thumb: res.thumb });
    return { ...res, label };
  } catch (err) {
    if (signal?.aborted) throw abortError();
    chip({ type: 'step_done', id: call.id, status: 'error', summary: err.message });
    return { text: `Error: ${err.message}`, label };
  }
}

async function runAgent({
  model, messages, tools, systemPrompt, chat, approve, getMode, emit, signal, ctx,
  maxSteps = MAX_STEPS, grants = new Set(), takeQueued = null, quickStart = false,
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Messages the person sent (typed or said) while Lumio was working join the
  // conversation before the next step, so it can change course.
  const absorb = (queued = takeQueued?.() || []) => {
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
  let quick = quickStart; // a voice message: the first answer is quick too, so it starts talking sooner
  const stuck = stuckWatch();

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw abortError();
    emit({ type: 'thinking' });
    const modelStart = Date.now();
    const prepared = prepareMessages(systemPrompt(), messages);
    // Screenshots it won't send again are let go, so a long task doesn't
    // hold hundreds of them in memory (what's sent is the same either way).
    prepared.forEach((m, i) => { if (i && isScreenshots(m)) messages[i - 1] = m; });
    const gen = chat({ model, messages: prepared, tools: schemas, signal, quick });
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
      if (value.type === 'text') emit({ type: 'text', delta: value.text });
    }
    modelMs += Date.now() - modelStart;

    const calls = (result.toolCalls || []).slice(0, MAX_CALLS);
    const dropped = (result.toolCalls?.length || 0) - calls.length;
    const assistant = { role: 'assistant', content: result.content || (calls.length ? null : '(no reply)') };
    if (calls.length) {
      assistant.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
    }
    messages.push(assistant);
    if (result.content) emit({ type: 'text_end' });

    if (!calls.length) {
      if (absorb()) { quick = false; continue; } // they said something while it answered: answer that too
      const reason = result.finishReason === 'length' ? 'length' : 'complete';
      emit({ type: 'done', reason, timing: timing(step + 1) });
      return { steps: step + 1, reason };
    }

    const images = [];
    const results = [];
    let trouble = false;
    for (const call of calls) {
      const toolStart = Date.now();
      const out = await runToolCall(call, env);
      toolMs += Date.now() - toolStart;
      const text = out.text || 'Done.';
      if (/^(Error|Refused)\b/.test(text) || out.status === 'blocked') trouble = true;
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      if (out.image) images.push(out.image);
      results.push({ text, sig: out.sig, label: out.label || call.name });
    }
    const last = messages[messages.length - 1];
    if (dropped > 0) last.content += `\n\n[Lumio Browser, not the user] Only your first ${MAX_CALLS} tool calls ran; the other ${dropped} did not. Call them again if you still need them.`;
    // Tips saved for a site it just arrived on: added to the last result.
    const tips = ctx?.siteTips?.();
    if (tips) last.content += `\n\n${tips}`;
    // Doing the same thing again with the same result: first a note to try
    // something else, then the task ends (unless the person just said something).
    const said = takeQueued?.() || [];
    const { verdict, times, loop, waiting, minutes } = await stuck(calls, results, ctx);
    if (said.length) stuck.heard();
    else if (verdict === 'nudge') {
      last.content += waiting
        ? `\n\n[Lumio Browser, not the user] You have checked ${times} times${minutes ? ` over ${minutes} minute${minutes === 1 ? '' : 's'}` : ''} and nothing has changed. If you are waiting for something, use wait between checks, and keep waiting only if it is still likely to finish; otherwise try something else, or stop and tell the user what is blocking you.`
        : loop
          ? `\n\n[Lumio Browser, not the user] Your last ${loop} steps repeated earlier ones with the same results, so this is not working. Try a different approach, or stop and tell the user what is blocking you.`
          : `\n\n[Lumio Browser, not the user] You have now done this same step ${times} times with the same result, so it is not working. Try a different approach, or stop and tell the user what is blocking you.`;
    } else if (verdict === 'stop') {
      last.content += waiting
        ? `\n\n[Lumio Browser, not the user] Lumio stopped the task here because nothing changed for ${minutes} minutes. If the user says to continue, keep waiting or try a different approach.`
        : '\n\n[Lumio Browser, not the user] Lumio stopped the task here because you kept repeating the same step. If the user says to continue, try a different approach.';
    }
    if ((said.length || verdict !== 'stop') && maxSteps - (step + 1) === WRAP_UP) {
      last.content += `\n\n[Lumio Browser, not the user] This task can take only ${WRAP_UP} more steps. Finish up now: reply with what you did and found, and what is still left to do.`;
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
    const heard = absorb(said);
    if (!heard && verdict === 'stop') {
      const what = results.map((r) => r.label).join(', ').slice(0, 80);
      const waited = waiting ? { waited: minutes } : {}; // it gave up waiting: for how many minutes nothing changed
      emit({ type: 'done', reason: 'stuck', what, ...waited, timing: timing(step + 1) });
      return { steps: step + 1, reason: 'stuck', what, ...waited };
    }
    quick = !trouble && !heard && !verdict && !calls.some((c) => THINK_AFTER.has(c.name)) && (step + 1) % 10 !== 0;
  }
  // The safety ceiling (see MAX_STEPS).
  emit({ type: 'done', reason: 'max_steps', steps: maxSteps, timing: timing(maxSteps) });
  return { steps: maxSteps, reason: 'max_steps' };
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

module.exports = { runAgent, prepareMessages, toolSchemas, abortError, repairHistory, MAX_STEPS, UNATTENDED_STEPS, VOLATILE };
