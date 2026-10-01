// A small stand-in used by the tests for both lumio-usa.online (the sign-in
// page that sets the site's session cookie, /api/account, /api/usage, logout)
// and its AI routes (/v1/agent streaming NDJSON, /v1/usage), behaving like
// the real services.
import http from 'node:http';
import crypto from 'node:crypto';
import { scriptedTurn, turnEvents } from './mock-scripts.mjs';

// The model the server says it runs (the browser must use whatever is listed).
const MODEL = { id: 'mock/agent-1', name: 'Mock Agent', maker: 'Lumio', minimumPlan: 'free', available: true };
// The tools the real server owns (server/src/agent.ts).
const TOOLS = ['read_page', 'click', 'type', 'select_option', 'press_key', 'scroll', 'navigate', 'go_back', 'screenshot_tab', 'click_at',
  'list_tabs', 'open_tab', 'switch_tab', 'close_tab', 'wait', 'computer_screenshot', 'computer_click', 'computer_move', 'computer_drag',
  'computer_scroll', 'computer_type', 'computer_key', 'open_app', 'list_apps', 'run_shell', 'update_plan', 'run_applescript',
  'generate_image', 'create_document'];
// A 2x2 PNG for /v1/images.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNkYPj/n4GBgYHhPwMDAwAt8gP9tA3e2wAAAABJRU5ErkJggg==';

export async function startMockLumio({ plan = 'plus' } = {}) {
  const sessions = new Map(); // token -> { email, name }
  // connected: which apps are connected (the + menu); tools: what /v1/tools/run did.
  const state = { plan, agentRequests: [], agentScript: null, connected: new Set(), toolRuns: [], images: 0 };
  const APPS = [['google_drive', 'Google Drive', 'drive'], ['gmail', 'Gmail', 'gmail'], ['outlook', 'Outlook', 'mail'], ['onedrive', 'OneDrive', 'files'], ['word', 'Word', 'files']];
  const remoteTools = () => (state.connected.has('gmail') ? [{ name: 'gmail_search', app: 'Gmail' }, { name: 'gmail_read', app: 'Gmail' }] : []);
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b; };
  // The website reads its session cookie; the AI routes read a bearer token.
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
    const week = { id: 'weekly', label: 'Weekly usage', limit: 1000, used: 380, remaining: 620, resetsAt: Date.now() + 3 * 86400000, fullAt: Date.now() + 3 * 86400000, refillsAt: Date.now() + 86400000 };
    return { ...week, plan: state.plan, planName: names[state.plan], windows: [week] };
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
      // ---- AI routes (/v1)
      if (url.pathname === '/v1/usage') {
        if (!bearer(req)) return json(res, 401, { error: 'Sign in to your Lumio account.', code: 'sign_in_required' });
        return json(res, 200, { usage: allowance() });
      }
      if (url.pathname === '/v1/agent' && req.method === 'GET') {
        const u = bearer(req);
        if (!u) return json(res, 401, { enabled: false });
        // Like the real endpoint: the model it runs, the server's tools, reasoning levels.
        return json(res, 200, {
          version: 1, enabled: true, plan: state.plan,
          model: MODEL, models: [MODEL], remoteTools: remoteTools(),
          tools: [...TOOLS, ...remoteTools().map((t) => t.name)], reasoning: { levels: ['low', 'medium', 'high'], default: 'medium' }, usage: allowance(),
        });
      }
      if (url.pathname === '/v1/agent' && req.method === 'POST') {
        const u = bearer(req);
        if (!u) return json(res, 401, { error: 'Sign in to your Lumio account first.', code: 'sign_in_required' });
        const body = JSON.parse(await readBody(req));
        // The same shape checks as the real endpoint's validation.
        const bad = body.version !== 1 || !body.taskId || !body.runId || !body.stepId || !body.context
          || body.model !== MODEL.id || !['low', 'medium', 'high'].includes(body.reasoning ?? 'medium')
          || !Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string' || ![...TOOLS, ...remoteTools().map((x) => x.name)].includes(t))
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
      // ---- pictures, Office files, connected apps
      if (url.pathname === '/v1/images' && req.method === 'POST') {
        if (!bearer(req)) return json(res, 401, { error: 'Sign in.', code: 'sign_in_required' });
        const body = JSON.parse(await readBody(req));
        state.images++;
        state.lastImagePrompt = body.prompt;
        return json(res, 200, { image: PNG, mime: 'image/png', model: 'Mock Image' });
      }
      if (url.pathname === '/v1/extract' && req.method === 'POST') {
        if (!bearer(req)) return json(res, 401, { error: 'Sign in.', code: 'sign_in_required' });
        const name = decodeURIComponent(req.headers['x-file-name'] || '');
        const bytes = Buffer.from(await readBody(req), 'latin1');
        return json(res, 200, { text: `Extracted ${name} (${bytes.length} bytes): Quarterly plan`, parts: 1, kind: 'docx' });
      }
      if (url.pathname === '/v1/tools/run' && req.method === 'POST') {
        if (!bearer(req)) return json(res, 401, { error: 'Sign in.', code: 'sign_in_required' });
        const body = JSON.parse(await readBody(req));
        state.toolRuns.push(body);
        if (!remoteTools().some((t) => t.name === body.name)) return json(res, 400, { error: 'That app isn’t connected.', code: 'tool_not_allowed' });
        return json(res, 200, { text: '- id: m1 | Tue | From: Boss <boss@co.com> | Subject: Q3 numbers' });
      }
      if (url.pathname === '/api/connections') {
        if (!who(req)) return json(res, 401, { error: 'Sign in.', code: 'sign_in_required' });
        return json(res, 200, { apps: APPS.map(([id, name, service]) => ({ id, name, service, provider: 'x', blurb: `${name} blurb`, available: true, connected: state.connected.has(id), account: state.connected.has(id) ? 'tester@example.com' : null })) });
      }
      if (/^\/api\/connect\/[a-z_]+\/start$/.test(url.pathname)) {
        state.connected.add(url.pathname.split('/')[3]);
        res.writeHead(302, { location: '/account?connected=1' });
        return res.end();
      }
      if (url.pathname === '/account') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Account</title><h1>Connected</h1>'); }
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      json(res, 500, { error: String(err.message || err) });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state, sessions };
}
