// The scripted "model" behind the fake Lumio server (tests/mock-lumio.mjs):
// given the conversation so far, decide the next turn. A turn is either text,
// tool calls (with optional lead-in text), or an HTTP failure.
const textOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : m.content || '');

function refFor(snapshotText, pattern) {
  const line = snapshotText.split('\n').find((l) => pattern.test(l));
  const m = line && line.match(/^\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

export function scriptedTurn(msgs) {
  // Find the last real user turn (not the tool-screenshot follow-up).
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !/^Screenshot\(s\) from the tool/.test(textOf(msgs[i]))) { lastUser = i; break; }
  }
  const ask = textOf(msgs[lastUser] || {}).toLowerCase();
  const after = msgs.slice(lastUser + 1);
  const step = after.filter((m) => m.role === 'assistant').length;
  const lastTool = [...after].reverse().find((m) => m.role === 'tool');
  const snapshot = [...after].reverse().find((m) => m.role === 'tool' && /^Tab \d+:/.test(m.content))?.content || '';

  if (ask.includes('save this as a workflow')) {
    if (step === 0) return { calls: [{ name: 'save_workflow', args: { title: 'Page summary', instructions: 'Open {page} and summarize it in three bullet points.', inputs: [{ name: 'page', label: 'Which page' }] } }] };
    return { text: `Saved. ${(lastTool?.content || '').split('.')[0]}.` };
  }
  if (ask.includes('<workflow title="page summary">')) return { text: 'Here is the summary of the page you picked.' };
  if (ask.includes('every morning at 8')) {
    if (step === 0) return { calls: [{ name: 'schedule_task', args: { title: 'Morning news', prompt: 'Say good morning with three headlines', repeat: 'daily', time: '08:00' } }] };
    return { text: `Scheduled. ${(lastTool?.content || '').split('.')[0]}.` };
  }
  if (ask.includes('pizza')) {
    if (step === 0) return { lead: "I'll fill in the order form.", calls: [{ name: 'read_page' }] };
    if (step === 1) {
      return { calls: [
        { name: 'type', args: { ref: refFor(snapshot, /textbox "Your name"/), text: 'Sam Tester' } },
        { name: 'type', args: { ref: refFor(snapshot, /textbox "Email"/), text: 'sam@example.com' } },
        { name: 'select_option', args: { ref: refFor(snapshot, /select "Size"/), value: 'Large' } },
        { name: 'click', args: { ref: refFor(snapshot, /checkbox/) } },
        { name: 'type', args: { ref: refFor(snapshot, /password/), text: 'hunter2' } },
        { name: 'type', args: { ref: refFor(snapshot, /Tap here to fill the secret/), text: 'hunter3' } },
      ] };
    }
    if (step === 2) return { calls: [{ name: 'click', args: { ref: refFor(snapshot, /button "Place order"/) } }] };
    if (step === 3) return { calls: [{ name: 'read_page' }] };
    const result = (lastTool?.content.match(/Order placed for[^\n]*/) || ['(no result found)'])[0];
    return { text: `Done! **${result}**\n\nI left the password field for you to fill in yourself.` };
  }
  if (ask.includes('plan a trip')) {
    const steps = (a, b, c) => ({ name: 'update_plan', args: { steps: [{ title: 'Pick the dates', status: a }, { title: 'Compare hotels', status: b }, { title: 'Book the best one', status: c }] } });
    if (step === 0) return { calls: [steps('in_progress', 'pending', 'pending'), { name: 'read_page' }] };
    if (step === 1) return { calls: [steps('done', 'in_progress', 'pending'), { name: 'wait', args: { seconds: 1.5 } }] };
    if (step === 2) return { calls: [steps('done', 'done', 'done')] };
    return { text: 'All set: dates picked, hotels compared, and the best one booked.' };
  }
  if (ask.includes('work on this page')) {
    if (step === 0) return { calls: [{ name: 'read_page' }] };
    return { calls: [{ name: 'wait', args: { seconds: 20 } }] };
  }
  if (ask.includes('screenshot')) {
    if (step === 0) return { calls: [{ name: 'screenshot_tab' }] };
    return { text: `I can see the page. Images received: ${msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length}.` };
  }
  // A browser action that leaves the page as it is: Ask mode asks first.
  if (ask.includes('press end')) {
    if (step === 0) return { calls: [{ name: 'press_key', args: { keys: 'End' } }] };
    return { text: `Done: ${(lastTool?.content || '').split('.')[0]}.` };
  }
  // A link to the mail app: refused, Lumio stays in the browser.
  if (ask.includes('email the team')) {
    if (step === 0) return { calls: [{ name: 'navigate', args: { url: 'mailto:team@example.com' } }] };
    return { text: `Couldn't: ${lastTool?.content || ''}` };
  }
  if (ask.includes('summarize')) {
    const hasPage = msgs.some((m) => /<current_page/.test(textOf(m)));
    return { text: hasPage ? '- Lighthouses are ancient.\n- Keepers ran them.\n- Most are automated now.' : 'I could not see the page.' };
  }
  if (ask.includes('draw')) {
    if (step === 0) return { calls: [{ name: 'generate_image', args: { prompt: 'A red fox in snow', aspect: 'square' } }] };
    return { text: 'Here is your fox.' };
  }
  if (ask.includes('make a pdf') || ask.includes('make a deck')) {
    const format = ask.includes('deck') ? 'pptx' : 'pdf';
    if (step === 0) return { calls: [{ name: 'create_document', args: { title: 'Trip Plan', format, content: '# Trip Plan\n\nThree days in Lisbon.\n\n## Day 1\n\n- Alfama\n- Tram 28\n\n| Item | Cost |\n|---|---|\n| Hotel | €240 |' } }] };
    return { text: `Your ${format.toUpperCase()} is ready.` };
  }
  if (ask.includes('my email')) {
    if (step === 0) return { calls: [{ name: 'gmail_search', args: { query: 'from:boss' } }] };
    return { text: `From Gmail: ${(lastTool?.content || '').split('|').pop().trim()}` };
  }
  if (ask.includes('these files')) {
    const parts = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const pics = parts.filter((p) => p.type === 'image_url').length;
    const files = parts.filter((p) => p.type === 'text' && p.text.startsWith('<file name=')).map((p) => p.text.match(/name="([^"]+)"/)[1]);
    return { text: `I got ${pics} picture(s) and these files: ${files.join(', ')}.` };
  }
  if (ask.includes('out of allowance')) {
    return { fail: { status: 429, body: { error: 'You’ve used this week’s Lumio AI allowance on the Free plan.', code: 'usage_limit' } } };
  }
  return { text: 'Hello! I am a **mock** model.\n\n```js\nconsole.log("hi")\n```' };
}

// The same turn as the NDJSON events /api/browser/agent streams.
export function turnEvents(turn) {
  if (turn.text != null) {
    const chunks = turn.text.match(/.{1,12}/gs) || [''];
    return [
      ...chunks.map((content) => ({ type: 'delta', content })),
      { type: 'result', message: { role: 'assistant', content: turn.text }, finishReason: 'stop', usage: { input: 900, output: 40, total: 940 } },
    ];
  }
  const toolCalls = turn.calls.map((c) => ({ id: `call_${c.name}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
  return [
    ...(turn.lead ? [{ type: 'delta', content: turn.lead }] : []),
    ...toolCalls.map((tool_call) => ({ type: 'tool_call', tool_call })),
    { type: 'result', message: { role: 'assistant', content: turn.lead || null, tool_calls: toolCalls }, finishReason: 'tool_calls', usage: { input: 900, output: 40, total: 940 } },
  ];
}
