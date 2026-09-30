// A tiny fake OpenRouter for end-to-end tests. It streams SSE exactly like the
// real API (split chunks, comment lines, tool-call deltas) and follows a
// script based on the conversation so far.
import http from 'node:http';

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(': OPENROUTER PROCESSING\n\n');
  let i = 0;
  const next = () => {
    if (i >= chunks.length) { res.end('data: [DONE]\n\n'); return; }
    const payload = JSON.stringify(chunks[i++]);
    // Split each event in two writes to exercise the incremental parser.
    const cut = Math.floor(payload.length / 2);
    res.write('data: ' + payload.slice(0, cut));
    setTimeout(() => { res.write(payload.slice(cut) + '\n\n'); setTimeout(next, 15); }, 5);
  };
  next();
}

const textChunks = (text) => [
  ...text.match(/.{1,12}/gs).map((t) => ({ choices: [{ delta: { content: t } }] })),
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 42 } },
];

function toolChunks(calls) {
  const out = [];
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.args || {});
    const half = Math.ceil(args.length / 2);
    out.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${c.name}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: c.name, arguments: args.slice(0, half) } }] } }] });
    out.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }] });
  });
  out.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  return out;
}

const textOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : m.content || '');

function refFor(snapshotText, pattern) {
  const line = snapshotText.split('\n').find((l) => pattern.test(l));
  const m = line && line.match(/^\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

export function startMockOpenRouter(port = 0) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || '';
    if (req.url.startsWith('/api/v1/key')) {
      if (!auth.includes('sk-or-test')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { label: 'test key', usage: 0, limit: null } }));
      return;
    }
    if (req.url.startsWith('/api/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000002', completion: '0.00001' }, context_length: 200000 },
        { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000004', completion: '0.00002' }, context_length: 200000 },
        { id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000001', completion: '0.000005' }, context_length: 400000 },
        { id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000001', completion: '0.000005' }, context_length: 400000 },
        { id: 'openai/gpt-5.6-terra', name: 'OpenAI: GPT-5.6 Terra', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000001', completion: '0.000006' }, context_length: 1050000 },
        { id: 'test/text-only', name: 'Test: Text Only', architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, context_length: 8000 },
      ] }));
      return;
    }
    if (req.url.startsWith('/api/v1/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      const json = JSON.parse(body);
      log.push(json);
      const msgs = json.messages;
      // Find the last real user turn (not the tool-screenshot follow-up).
      let lastUser = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && !/^Screenshot\(s\) from the tool/.test(textOf(msgs[i]))) { lastUser = i; break; }
      }
      const ask = textOf(msgs[lastUser]).toLowerCase();
      const after = msgs.slice(lastUser + 1);
      const step = after.filter((m) => m.role === 'assistant').length;
      const lastTool = [...after].reverse().find((m) => m.role === 'tool');
      const snapshot = [...after].reverse().find((m) => m.role === 'tool' && /^Tab \d+:/.test(m.content))?.content || '';

      if (ask.includes('pizza')) {
        if (step === 0) return sse(res, [{ choices: [{ delta: { content: "I'll fill in the order form." } }] }, ...toolChunks([{ name: 'read_page' }])]);
        if (step === 1) {
          return sse(res, toolChunks([
            { name: 'type', args: { ref: refFor(snapshot, /textbox "Your name"/), text: 'Sam Tester' } },
            { name: 'type', args: { ref: refFor(snapshot, /textbox "Email"/), text: 'sam@example.com' } },
            { name: 'select_option', args: { ref: refFor(snapshot, /select "Size"/), value: 'Large' } },
            { name: 'click', args: { ref: refFor(snapshot, /checkbox/) } },
            { name: 'type', args: { ref: refFor(snapshot, /password/), text: 'hunter2' } },
            { name: 'type', args: { ref: refFor(snapshot, /Tap here to fill the secret/), text: 'hunter3' } },
          ]));
        }
        if (step === 2) return sse(res, toolChunks([{ name: 'click', args: { ref: refFor(snapshot, /button "Place order"/) } }]));
        if (step === 3) return sse(res, toolChunks([{ name: 'read_page' }]));
        const result = (lastTool?.content.match(/Order placed for[^\n]*/) || ['(no result found)'])[0];
        return sse(res, textChunks(`Done! **${result}**\n\nI left the password field for you to fill in yourself.`));
      }
      if (ask.includes('screenshot')) {
        if (step === 0) return sse(res, toolChunks([{ name: 'screenshot_tab' }]));
        return sse(res, textChunks(`I can see the page. Images received: ${msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length}.`));
      }
      if (ask.includes('apps')) {
        if (step === 0) return sse(res, toolChunks([{ name: 'list_apps' }]));
        return sse(res, textChunks(`Running apps:\n${(lastTool?.content || '').split('\n').slice(0, 3).join('\n')}`));
      }
      if (ask.includes('my screen')) {
        if (step === 0) return sse(res, toolChunks([{ name: 'computer_screenshot' }]));
        return sse(res, textChunks(lastTool?.content.startsWith('Error') ? 'I need Screen Recording permission first.' : 'I can see your screen.'));
      }
      if (ask.includes('shell')) {
        if (step === 0) return sse(res, toolChunks([{ name: 'run_shell', args: { command: 'echo lumio-$((6*7))', explanation: 'Print a test value' } }]));
        return sse(res, textChunks(`Shell said: ${(lastTool?.content || '').split('\n')[1]}`));
      }
      if (ask.includes('summarize')) {
        const hasPage = msgs.some((m) => /<current_page/.test(textOf(m)));
        return sse(res, textChunks(hasPage ? '- Lighthouses are ancient.\n- Keepers ran them.\n- Most are automated now.' : 'I could not see the page.'));
      }
      if (ask.includes('fail')) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }));
        return;
      }
      return sse(res, textChunks('Hello! I am a **mock** model.\n\n```js\nconsole.log("hi")\n```'));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, log, base: `http://127.0.0.1:${server.address().port}/api/v1` })));
}
