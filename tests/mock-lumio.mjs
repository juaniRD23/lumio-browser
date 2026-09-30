// A small stand-in for lumio-usa.online used by the tests: the desktop
// sign-in hand-off, /api/account, /api/usage, logout, and the browser agent
// endpoint (NDJSON), all behaving like the real site.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startMockLumio({ plan = 'plus' } = {}) {
  const logins = new Map(); // id -> { challenge, approved, expiresAt }
  const sessions = new Map(); // token -> { email, plan }
  const state = { plan, agentRequests: [], agentScript: null };
  const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b; };
  const who = (req) => {
    const m = /(?:^|;\s*)(?:__Host-)?lumio_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    return m ? sessions.get(m[1]) : null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/auth/desktop' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.action === 'start') {
          if (!/^[a-f0-9]{64}$/.test(body.challenge || '')) return json(res, 400, { error: 'Invalid request.' });
          const id = crypto.randomBytes(32).toString('hex');
          logins.set(id, { challenge: body.challenge, approved: false, expiresAt: Date.now() + 300000 });
          return json(res, 201, { id, expiresAt: Date.now() + 300000, url: 'https://lumio-usa.online/desktop-connect?request=' + id });
        }
        const login = logins.get(body.id);
        if (body.action === 'approve') { if (!login) return json(res, 409, { error: 'expired' }); login.approved = true; return json(res, 200, { approved: true }); }
        if (!login || sha(body.verifier || '') !== login.challenge) return json(res, 410, { error: 'Sign-in expired. Start again.' });
        if (body.action === 'cancel') { logins.delete(body.id); return json(res, 200, { cancelled: true }); }
        if (body.action === 'poll') {
          if (!login.approved) return json(res, 202, { pending: true });
          logins.delete(body.id);
          const token = crypto.randomBytes(32).toString('hex');
          sessions.set(token, { email: 'tester@lumio.test', name: 'Test Person' });
          return json(res, 200, { token, expiresAt: Date.now() + 86400000 });
        }
      }
      if (url.pathname === '/desktop-connect') {
        const id = url.searchParams.get('request') || '';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<title>Connect Lumio</title><h1>Connect your app</h1><p id="code">${id.slice(0, 6).toUpperCase()}</p>
          <button id="connect" onclick="fetch('/api/auth/desktop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'approve',id:'${id}'})}).then(()=>{document.body.dataset.done='1'})">Connect</button>`);
        return;
      }
      if (url.pathname === '/api/auth' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.action === 'logout') {
          const m = /lumio_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
          if (m) sessions.delete(m[1]);
          return json(res, 200, { ok: true });
        }
      }
      if (url.pathname === '/api/account') {
        const u = who(req);
        return json(res, 200, u ? { signedIn: true, email: u.email, username: null, publicUsername: 'tester', authMethod: 'lumio', profile: { name: u.name } } : { signedIn: false });
      }
      if (url.pathname === '/api/usage') {
        const u = who(req);
        if (!u) return json(res, 200, { usage: { plan: 'free', planName: 'Free', remaining: 0, limit: 0, windows: [] } });
        const names = { free: 'Free', plus: 'Plus', pro: 'Pro', max: 'Max' };
        const week = { id: 'weekly', label: 'Weekly usage limit', limit: 1000, used: 380, held: 0, remaining: 620, resetsAt: Date.now() + 3 * 86400000 };
        return json(res, 200, { usage: { plan: state.plan, planName: names[state.plan], remaining: 620, limit: 1000, resetsAt: week.resetsAt, windows: [week] } });
      }
      if (url.pathname === '/api/browser/agent' && req.method === 'GET') {
        const u = who(req);
        if (!u) return json(res, 401, { enabled: false });
        const order = ['free', 'go', 'plus', 'pro', 'max'];
        const models = [['anthropic/claude-opus-5.5', 'plus'], ['anthropic/claude-sonnet-5.5', 'plus'], ['openai/gpt-6-astra', 'pro'], ['openai/gpt-6.1-sol', 'plus'], ['openai/gpt-5.6-sol', 'plus'], ['openai/gpt-5.6-terra', 'plus']]
          .map(([id, minimumPlan]) => ({ id, minimumPlan, available: order.indexOf(state.plan) >= order.indexOf(minimumPlan) }));
        return json(res, 200, { version: 1, enabled: order.indexOf(state.plan) >= 2, plan: state.plan, models });
      }
      if (url.pathname === '/api/browser/agent' && req.method === 'POST') {
        const u = who(req);
        if (!u) return json(res, 401, { error: 'Sign in to your Lumio account first.', code: 'sign_in_required' });
        if (!['plus', 'pro', 'max'].includes(state.plan)) return json(res, 403, { error: 'Lumio AI in the browser needs Plus, Pro or Max.', code: 'browser_plan_required' });
        const body = JSON.parse(await readBody(req));
        // The same shape checks as the real endpoint's validation.
        const bad = body.version !== 1 || !body.taskId || !body.runId || !body.stepId || !body.context
          || !Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string')
          || body.messages.some((m) => m.role === 'system') || body.messages[0]?.role !== 'user';
        if (bad) return json(res, 400, { error: 'Invalid browser step.', code: 'invalid_request' });
        state.agentRequests.push(body);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const events = state.agentScript ? state.agentScript(body) : [
          { type: 'delta', content: 'Hello from your **Lumio plan**.' },
          { type: 'result', message: { role: 'assistant', content: 'Hello from your **Lumio plan**.' }, finishReason: 'stop', usage: { input: 10, output: 5, total: 15 } },
        ];
        for (const e of events) res.write(JSON.stringify({ version: 1, taskId: body.taskId, runId: body.runId, stepId: body.stepId, ...e }) + '\n');
        res.end();
        return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      json(res, 500, { error: String(err.message || err) });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state, sessions };
}
