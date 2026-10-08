// A stand-in for the Lumio server's /v1/agent, as LumioAccount.fetch, for
// driving lumioChat (and the AI controller) without a network. `reply(body, n)`
// gives the n-th step's answer: { calls: [{ name, arguments }], text } for a
// streamed result, or { status, error, code } for a refusal.
export function fakeAccount(reply, { tools = [] } = {}) {
  const bodies = [];
  return {
    bodies,
    aiBase: 'https://lumio.test',
    token: () => 'token',
    state: () => ({ signedIn: true, paid: true, plan: 'plus' }),
    refresh: async () => {},
    async fetch(url, init = {}) {
      // GET: what the plan allows (lumioCapabilities).
      if (!init.body) return Response.json({ tools, model: { id: 'mock/agent', name: 'Mock', maker: 'Lumio' }, remoteTools: [] });
      const body = JSON.parse(init.body);
      bodies.push(body);
      const r = reply(body, bodies.length);
      if (r.status) return Response.json({ error: r.error, code: r.code }, { status: r.status });
      const calls = (r.calls || []).map((c, i) => ({ id: `c${bodies.length}_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
      const lines = [
        ...(r.text ? [{ type: 'delta', content: r.text }] : []),
        { type: 'result', message: { role: 'assistant', content: r.text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finishReason: calls.length ? 'tool_calls' : 'stop', usage: {} },
      ];
      return new Response(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    },
  };
}

// Pictures in a request's messages.
export const imagesIn = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length;
