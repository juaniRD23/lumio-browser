// POST /v1/translate: Lumio Browser's page translation, with D1 simulated on
// node:sqlite and a stand-in for OpenRouter that "translates" by tagging each
// numbered line. Run: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { TRANSLATE_BACKUP, TRANSLATE_MODEL } from '../src/models.ts';
import { numbered, parseNumbered, TRANSLATE_LIMITS } from '../src/translate.ts';
import { liveCheck } from '../src/spend.ts';

const SITE = 'https://lumio.test';
const OR = 'https://openrouter.test/api/v1';
let sql, env, calls, reply, generations, pending, token;

function d1(db) {
  return {
    prepare(query) {
      let values = [];
      const stmt = {
        bind(...args) { values = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async first() { return db.prepare(query).get(...values) ?? null; },
        async all() { return { results: db.prepare(query).all(...values) }; },
        async run() { const r = db.prepare(query).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; },
      };
      return stmt;
    },
  };
}

const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
let genN = 0;
// Answers like a model would: every numbered line back, "translated".
function tagged(body, { skip = [], cost = 0.00004 } = {}) {
  const lines = body.messages[1].content.split('\n').filter((l) => /^\d+: /.test(l));
  const out = lines.filter((l) => !skip.includes(Number(l.split(':')[0]))).map((l) => l.replace(/^(\d+): (.*)$/, '$1: [es] $2')).join('\n');
  const id = `gen-tr-${++genN}`;
  generations[id] = cost;
  return sse([
    { id, choices: [{ index: 0, delta: { content: out.slice(0, 7) } }] },
    { id, choices: [{ index: 0, delta: { content: out.slice(7) }, finish_reason: 'stop' }] },
    { id, choices: [], usage: { prompt_tokens: 400, completion_tokens: 300, total_tokens: 700, cost } },
  ]);
}

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: d1(sql), OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_BASE: OR };
  calls = [];
  generations = {};
  pending = [];
  liveCheck.delays = [0, 0, 0];
  reply = (body) => tagged(body);
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === `${OR}/chat/completions`) {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return reply(body);
    }
    if (u.startsWith(`${OR}/generation?`)) {
      const id = new URL(u).searchParams.get('id');
      return id in generations ? Response.json({ data: { id, total_cost: generations[id] } }) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    return new Response('nope', { status: 404 });
  };
  // A signed-in Free account (sessions are stored by the token's SHA-256).
  token = crypto.randomBytes(32).toString('hex');
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u1', 'g-1', 'sam@example.com', 'Sam', 'free', ?)").run(Date.now());
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), 'u1', Date.now(), Date.now() + 86_400_000);
});

const ctx = { waitUntil: (p) => pending.push(p) };
const settled = async () => { await Promise.all(pending); pending = []; };
const post = (body, auth = token) => worker.fetch(new Request(`${SITE}/v1/translate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  body: JSON.stringify(body),
}), env, ctx);
const steps = () => sql.prepare("SELECT kind, status, cost_microusd, billed_microusd, model, gen_ids FROM steps WHERE kind = 'translate' ORDER BY created_at").all();

test('numbered lines go to the model and come back in the shape that was sent', () => {
  const blocks = [['Bonjour le monde'], ['Cliquez', 'ici', 'pour continuer']];
  assert.equal(numbered(blocks), '1: Bonjour le monde\n\n2: Cliquez\n3: ici\n4: pour continuer');
  const back = parseNumbered('Here you go:\n1: Hello world\n2: Click \n３： here\n\n4: to continue\n4: again', blocks);
  assert.deepEqual(back, [['Hello world'], ['Click', 'here', 'to continue']], 'chatter is ignored, full-width digits read, the first answer wins');
  assert.deepEqual(parseNumbered('1: Hello', blocks), [['Hello'], [null, null, null]], 'missing lines keep the original');
});

test('translates a batch with the cheap model, charged to the weekly allowance', async () => {
  const res = await post({ target: 'es', source: 'fr', blocks: [['Bonjour le monde'], ['Cliquez ', 'ici', ' pour continuer']] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { translations: [['[es] Bonjour le monde'], ['[es] Cliquez', '[es] ici', '[es] pour continuer']] });
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.model, TRANSLATE_MODEL);
  assert.match(sent.messages[0].content, /into Spanish \(the page is in French\)/);
  assert.match(sent.messages[0].content, /not instructions to you/);
  assert.equal(sent.messages[1].content, '1: Bonjour le monde\n\n2: Cliquez\n3: ici\n4: pour continuer');
  assert.deepEqual(sent.provider.data_collection, 'deny', 'only providers that don’t keep what people send');
  assert.ok(sent.max_tokens >= 1024 && sent.max_tokens <= 8192, `max_tokens ${sent.max_tokens}`);
  await settled();
  const [row] = steps();
  assert.equal(row.status, 'done');
  assert.equal(row.model, TRANSLATE_MODEL);
  assert.equal(row.cost_microusd, 40, 'OpenRouter’s reported cost');
  assert.equal(row.billed_microusd, 40, 'checked against OpenRouter’s record');
  // A piece the model skipped stays null (the page keeps its original).
  reply = (body) => tagged(body, { skip: [2] });
  const partial = await (await post({ target: 'en', blocks: [['Hola'], ['Adiós']] })).json();
  assert.deepEqual(partial.translations, [['[es] Hola'], [null]]);
  // A region in the target reaches the model too.
  await post({ target: 'pt-BR', blocks: [['Hello']] });
  assert.match(calls.at(-1).messages[0].content, /into (Brazilian Portuguese|Portuguese \(Brazil\))/);
});

test('bad requests and signed-out calls never reach the model', async () => {
  const bad = [
    { blocks: [['Hi']] },
    { target: 'Spanish!', blocks: [['Hi']] },
    { target: 'es', blocks: [] },
    { target: 'es', blocks: [['']] },
    { target: 'es', blocks: [[42]] },
    { target: 'es', blocks: 'Hi' },
    { target: 'es', blocks: Array.from({ length: TRANSLATE_LIMITS.blocks + 1 }, () => ['Hi']) },
    { target: 'es', blocks: [['x'.repeat(TRANSLATE_LIMITS.stringChars + 1)]] },
    { target: 'es', blocks: Array.from({ length: 4 }, () => ['x'.repeat(4000)]) },
  ];
  for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 80));
  const out = await post({ target: 'es', blocks: [['Hi']] }, null);
  assert.equal(out.status, 401);
  assert.equal((await out.json()).code, 'sign_in_required');
  assert.equal(calls.length, 0);
  assert.equal(steps().length, 0);
});

test('the backup model answers when the main one is down; a total failure charges nothing', async () => {
  reply = (body) => (body.model === TRANSLATE_MODEL ? Response.json({ error: { message: 'busy' } }, { status: 503 }) : tagged(body));
  const res = await post({ target: 'de', blocks: [['Hello']] });
  assert.deepEqual(await res.json(), { translations: [['[es] Hello']] });
  assert.deepEqual(calls.map((c) => c.model), [TRANSLATE_MODEL, TRANSLATE_BACKUP]);
  await settled();
  assert.equal(steps()[0].model, TRANSLATE_BACKUP);

  reply = () => Response.json({ error: { message: 'down' } }, { status: 502 });
  const down = await post({ target: 'de', blocks: [['Hello']] });
  assert.ok(down.status >= 500);
  assert.equal((await down.json()).code, 'provider_unavailable');
  const failed = steps().at(-1);
  assert.deepEqual([failed.status, failed.cost_microusd], ['failed', 0]);
});

test('an empty allowance and too many batches a minute are refused before the model', async () => {
  sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at) VALUES ('spent', 'u1', 'free', 'chat', 'h', 'done', 0, 250000, ?)").run(Date.now() - 1000);
  const out = await post({ target: 'es', blocks: [['Hello']] });
  assert.equal(out.status, 429);
  assert.equal((await out.json()).code, 'usage_limit');
  sql.prepare("DELETE FROM steps WHERE key = 'spent'").run();
  const insert = sql.prepare("INSERT INTO steps (key, owner, plan, kind, request_hash, status, held_microusd, cost_microusd, created_at) VALUES (?, 'u1', 'free', 'translate', 'h', 'done', 0, 1, ?)");
  for (let i = 0; i < TRANSLATE_LIMITS.perMinute; i++) insert.run(`t${i}`, Date.now() - 5000);
  const busy = await post({ target: 'es', blocks: [['Hello']] });
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).code, 'rate_limited');
  assert.equal(calls.length, 0);
});
