// A scripted stand-in for OpenRouter used to take the website's screenshots:
// the real Lumio agent drives the real browser; only the model's words are
// scripted. Scenarios: booking a table (osteria.html) and a summary (article.html).
import http from 'node:http';

const MODELS = [
  ['anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', 4, 20], ['anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 2, 10],
  ['openai/gpt-6-astra', 'OpenAI: GPT-6 Astra', 5, 25], ['openai/gpt-6.1-sol', 'OpenAI: GPT-6.1 Sol', 1, 5],
  ['openai/gpt-5.6-sol', 'OpenAI: GPT-5.6 Sol', 1, 5], ['openai/gpt-5.6-terra', 'OpenAI: GPT-5.6 Terra', 1, 6],
];

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const next = () => {
    if (i >= chunks.length) { res.end('data: [DONE]\n\n'); return; }
    res.write('data: ' + JSON.stringify(chunks[i++]) + '\n\n');
    setTimeout(next, 18);
  };
  next();
}
const text = (t) => [...t.match(/.{1,8}/gs).map((c) => ({ choices: [{ delta: { content: c } }] })), { choices: [{ delta: {}, finish_reason: 'stop' }] }];
const tools = (calls, lead) => [
  ...(lead ? [{ choices: [{ delta: { content: lead } }] }] : []),
  ...calls.map((c, index) => ({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}_${Math.random().toString(36).slice(2, 7)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }] } }] })),
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];
const textOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : m.content || '');
const ref = (snap, re) => { const l = snap.split('\n').find((x) => re.test(x)); return l ? Number(l.match(/^\[(\d+)\]/)?.[1]) : null; };

export function startDemoModel() {
  const server = http.createServer(async (req, res) => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/api/v1/key')) return json({ data: { label: 'demo', usage: 0, limit: null } });
    if (req.url.startsWith('/api/v1/models')) return json({ data: MODELS.map(([id, name, i, o]) => ({ id, name, architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: String(i / 1e6), completion: String(o / 1e6) }, context_length: 400000 })) });
    let body = '';
    for await (const c of req) body += c;
    const msgs = JSON.parse(body).messages;
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !/^Screenshot\(s\)/.test(textOf(msgs[i]))) { last = i; break; }
    const ask = textOf(msgs[last]).toLowerCase();
    const after = msgs.slice(last + 1);
    const step = after.filter((m) => m.role === 'assistant').length;
    const snap = [...after].reverse().find((m) => m.role === 'tool' && /^Tab \d+:/.test(m.content))?.content || '';
    if (ask.includes('book')) {
      if (step === 0) return sse(res, tools([{ name: 'read_page' }], 'On it. I’ll fill in the reservation form for you.'));
      if (step === 1) {
        return sse(res, tools([
          { name: 'type', args: { ref: ref(snap, /textbox "Your name"/), text: 'Sam Rivera' } },
          { name: 'type', args: { ref: ref(snap, /textbox "Email"/), text: 'sam@example.com' } },
          { name: 'select_option', args: { ref: ref(snap, /select "Party size"/), value: '2 guests' } },
          { name: 'select_option', args: { ref: ref(snap, /select "Time"/), value: '8:00 PM' } },
        ]));
      }
      if (step === 2) return sse(res, tools([{ name: 'click', args: { ref: ref(snap, /button "Reserve table"/) } }]));
      if (step === 3) return sse(res, tools([{ name: 'read_page', args: { include_text: true } }]));
      return sse(res, text('Done! Your **table for 2 at 8:00 PM** tonight at Osteria Luna is booked under Sam Rivera.\n\n- Confirmation: **LUNA-2841**\n- They hold tables for **15 minutes**, so aim to arrive on time.'));
    }
    if (ask.includes('summar')) {
      return sse(res, text('**Night skies are brightening about 10% a year**, much faster than satellites showed.\n\n- **Why:** blue-rich LED street lights scatter more and are hard for satellites to see.\n- **Effects:** lost migrating birds, fewer pollinating insects, worse human sleep.\n- **Fixes:** shielded, warmer, dimmer lights. Towns that did it saved money and got their stars back.'));
    }
    return sse(res, text('Happy to help. What would you like me to do?'));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}/api/v1` })));
}
