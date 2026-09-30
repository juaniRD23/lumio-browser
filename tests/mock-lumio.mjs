// A small stand-in used by the tests for both lumio-usa.online (the sign-in
// page that sets the site's session cookie, /api/account, /api/usage, logout)
// and lumio-browser-api (/v1/agent streaming NDJSON, /v1/usage), behaving like
// the real services.
import http from 'node:http';
import crypto from 'node:crypto';
import { scriptedTurn, turnEvents } from './mock-scripts.mjs';

// The tools the real server owns (lib/browser-agent.ts).
const TOOLS = ['read_page', 'click', 'type', 'select_option', 'press_key', 'scroll', 'navigate', 'go_back', 'screenshot_tab', 'click_at',
  'list_tabs', 'open_tab', 'switch_tab', 'close_tab', 'wait', 'computer_screenshot', 'computer_click', 'computer_move', 'computer_drag',
  'computer_scroll', 'computer_type', 'computer_key', 'open_app', 'list_apps', 'run_shell', 'update_plan', 'run_applescript'];

export async function startMockLumio({ plan = 'plus' } = {}) {
  const sessions = new Map(); // token -> { email, name }
  const state = { plan, agentRequests: [], agentScript: null };
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b; };
  // The website reads its session cookie; lumio-browser-api reads a bearer token.
  const who = (req) => {
    const m = /(?:^|;\s*)(?:__Host-)?lumio_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    return m ? sessions.get(m[1]) : null;
  };
  const bearer = (req) => {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    return m ? sessions.get(m[1]) : null;
  };
  const allowance = () => {
    const names = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', max: 'Max' };
    const week = { id: 'weekly', label: 'Weekly usage limit', limit: 1000, used: 380, held: 0, remaining: 620, resetsAt: Date.now() + 3 * 86400000 };
    return { plan: state.plan, planName: names[state.plan], remaining: 620, limit: 1000, resetsAt: week.resetsAt, windows: [week] };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // The website's own sign-in page: "Continue" logs in and sets the session cookie.
      if (url.pathname === '/signin') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<title>Sign in · Lumio</title><h1>Sign in to Lumio</h1><form method="post" action="/signin/continue"><button id="continue">Continue with Google</button></form>`);
        return;
      }
      if (url.pathname === '/signin/continue' && req.method === 'POST') {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { email: 'tester@lumio.test', name: 'Test Person' });
        res.writeHead(302, { location: '/', 'set-cookie': `lumio_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
        res.end();
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>Lumio</title><h1>Lumio</h1>');
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
        return json(res, 200, u ? { signedIn: true, ownerId: 'account:tester', email: u.email, username: null, publicUsername: 'tester', authMethod: 'lumio', profile: { name: u.name } } : { signedIn: false, ownerId: 'guest:x', authMethod: 'guest' });
      }
      if (url.pathname === '/api/usage') {
        const u = who(req);
        if (!u) return json(res, 200, { usage: { plan: 'free', planName: 'Free', remaining: 0, limit: 0, windows: [] } });
        return json(res, 200, { usage: allowance() });
      }
      // ---- lumio-browser-api
      if (url.pathname === '/v1/usage') {
        if (!bearer(req)) return json(res, 401, { error: 'Sign in to your Lumio account.', code: 'sign_in_required' });
        return json(res, 200, { usage: allowance() });
      }
      if (url.pathname === '/v1/agent' && req.method === 'GET') {
        const u = bearer(req);
        if (!u) return json(res, 401, { enabled: false });
        // Like the real endpoint: one model on every plan, the server's tools, reasoning levels.
        return json(res, 200, {
          version: 1, enabled: true, plan: state.plan,
          models: [{ id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', minimumPlan: 'free', available: true }],
          tools: TOOLS, reasoning: { levels: ['low', 'medium', 'high'], default: 'medium' }, usage: allowance(),
        });
      }
      if (url.pathname === '/v1/agent' && req.method === 'POST') {
        const u = bearer(req);
        if (!u) return json(res, 401, { error: 'Sign in to your Lumio account first.', code: 'sign_in_required' });
        const body = JSON.parse(await readBody(req));
        // The same shape checks as the real endpoint's validation.
        const bad = body.version !== 1 || !body.taskId || !body.runId || !body.stepId || !body.context
          || body.model !== 'openai/gpt-6-luna' || !['low', 'medium', 'high'].includes(body.reasoning ?? 'medium')
          || !Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string' || !TOOLS.includes(t))
          || body.messages.some((m) => m.role === 'system') || body.messages[0]?.role !== 'user';
        if (bad) return json(res, 400, { error: 'Invalid browser step.', code: 'invalid_request' });
        state.agentRequests.push(body);
        const turn = state.agentScript ? null : scriptedTurn(body.messages);
        if (turn?.fail) return json(res, turn.fail.status, turn.fail.body);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const events = state.agentScript ? state.agentScript(body) : turnEvents(turn);
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
