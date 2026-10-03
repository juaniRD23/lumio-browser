// Voice mode for Lumio Browser: speech to text for what the person says, and
// text to speech for Lumio's replies. Both are tiny next to the chat model
// (about $0.0002 per minute of talking and $0.0006 for a long answer) and are
// charged to the same weekly allowance, then checked against OpenRouter's
// real cost like every other call (spend.ts).
import type { Plan } from './agent.ts';
import { GEN_ID, ProviderError } from './openrouter.ts';
import { verifyNow } from './spend.ts';
import { hold, settle, toMicro } from './usage.ts';
import { AgentError, type Env, fail, json, randomHex, sha256 } from './util.ts';

export const VOICE = {
  // gpt-4o-transcribe: far fewer mistakes than Whisper with accents, names and
  // mixed English/Spanish (~$0.006 a minute, billed by OpenRouter's real cost).
  // If it fails, Whisper large-v3 tries the same audio.
  listen: { id: 'openai/gpt-4o-transcribe', perSecond: 0.0001, backup: { id: 'openai/whisper-large-v3', perSecond: 0.0000075 } },
  speak: { id: 'hexgrad/kokoro-82m', perChar: 0.00000062, voices: ['af_heart', 'af_bella', 'am_michael', 'bf_emma', 'bm_george'] },
};
const MAX_SECONDS = 120;
const MAX_AUDIO_B64 = 4 * 1024 * 1024; // about 3 MB of audio: two minutes of Opus with room to spare
const MAX_CHARS = 4000;
const FORMATS = ['webm', 'ogg', 'wav', 'mp3', 'm4a', 'mp4'];
const PER_MINUTE = 40;

// Holds a little more than the list price (never less than 100 microUSD), so
// a slightly pricier provider still fits; the real cost replaces it.
const holdFor = (usd: number) => Math.max(100, Math.ceil(usd * 1_000_000 * 3));

function openrouter(env: Env, path: string, body: unknown) {
  const base = (env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://lumio-usa.online', 'X-Title': 'Lumio' },
    body: JSON.stringify(body),
  }).catch(() => { throw new ProviderError('Couldn’t reach the voice model. Try again.'); });
}

async function tooFast(env: Env, owner: string) {
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM steps WHERE owner = ?1 AND kind = 'voice' AND created_at >= ?2").bind(owner, Date.now() - 60_000).first<{ n: number }>();
  return (recent?.n ?? 0) >= PER_MINUTE;
}

// POST /v1/voice/transcribe { audio: base64, format: 'webm', seconds, language? } -> { text }
export async function transcribe(request: Request, env: Env, user: { id: string; plan: Plan }, ctx: ExecutionContext) {
  if (!env.OPENROUTER_API_KEY) throw new AgentError('Lumio AI isn’t connected to its model right now.', 503, 'model_not_connected');
  const body = await request.json<{ audio?: unknown; format?: unknown; seconds?: unknown; language?: unknown }>().catch(() => null);
  const audio = typeof body?.audio === 'string' ? body.audio : '';
  if (!audio || audio.length > MAX_AUDIO_B64 || !/^[A-Za-z0-9+/]+=*$/.test(audio)) return fail('Send up to two minutes of audio.', 400, 'invalid_request');
  const format = FORMATS.includes(String(body?.format)) ? String(body!.format) : 'webm';
  const seconds = Math.min(MAX_SECONDS, Math.max(1, Number(body?.seconds) || audio.length / 2000)); // ~16 kB/s base64 for Opus; the client's count is better
  const language = typeof body?.language === 'string' && /^[a-z]{2}$/.test(body.language) ? body.language : undefined;
  if (await tooFast(env, user.id)) return fail('Slow down a little: too much talking in the last minute.', 429, 'rate_limited');

  const key = await sha256(`voice|${user.id}|${randomHex(8)}`);
  await hold(env, { key, owner: user.id, plan: user.plan, requestHash: key, kind: 'voice', held: holdFor(seconds * VOICE.listen.perSecond) });
  let cost = 0;
  const ids: string[] = [];
  try {
    const ask = (model: string) => openrouter(env, '/audio/transcriptions', {
      model,
      input_audio: { data: audio, format },
      ...(language ? { language } : {}),
      provider: { data_collection: 'deny', allow_fallbacks: true },
    });
    let used = VOICE.listen as { id: string; perSecond: number };
    let res = await ask(used.id).catch(() => null);
    if (!res || !res.ok) { used = VOICE.listen.backup; res = await ask(used.id); }
    const id = res.headers.get('x-generation-id');
    if (id && GEN_ID.test(id)) ids.push(id);
    const data = await res.json<any>().catch(() => null);
    if (typeof data?.id === 'string' && GEN_ID.test(data.id) && !ids.includes(data.id)) ids.push(data.id);
    if (typeof data?.usage?.cost === 'number') cost = toMicro(data.usage.cost);
    if (!res.ok || data?.error) throw new ProviderError('Couldn’t understand the audio right now. Try again.', res.status === 429 ? 503 : 502);
    const text = String(data?.text ?? '').trim();
    cost ||= toMicro((Number(data?.usage?.seconds) || seconds) * used.perSecond);
    await settle(env, key, cost, 'done', null, ids);
    ctx.waitUntil(verifyNow(env, [{ key, ids }]));
    return json({ text });
  } catch (err) {
    await settle(env, key, cost, 'failed', null, ids);
    throw err;
  }
}

// POST /v1/voice/speak { text, voice? } -> audio/mpeg
export async function speak(request: Request, env: Env, user: { id: string; plan: Plan }, ctx: ExecutionContext) {
  if (!env.OPENROUTER_API_KEY) throw new AgentError('Lumio AI isn’t connected to its model right now.', 503, 'model_not_connected');
  const body = await request.json<{ text?: unknown; voice?: unknown }>().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_CHARS) return fail(`Send 1 to ${MAX_CHARS.toLocaleString('en-US')} characters to read aloud.`, 400, 'invalid_request');
  const voice = VOICE.speak.voices.includes(String(body?.voice)) ? String(body!.voice) : VOICE.speak.voices[0];
  if (await tooFast(env, user.id)) return fail('Slow down a little: too much talking in the last minute.', 429, 'rate_limited');

  const key = await sha256(`voice|${user.id}|${randomHex(8)}`);
  const listPrice = text.length * VOICE.speak.perChar;
  await hold(env, { key, owner: user.id, plan: user.plan, requestHash: key, kind: 'voice', held: holdFor(listPrice) });
  const ids: string[] = [];
  try {
    const res = await openrouter(env, '/audio/speech', {
      model: VOICE.speak.id,
      input: text,
      voice,
      response_format: 'mp3',
      provider: { data_collection: 'deny', allow_fallbacks: true },
    });
    const id = res.headers.get('x-generation-id');
    if (id && GEN_ID.test(id)) ids.push(id);
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio/')) {
      await res.body?.cancel();
      throw new ProviderError('Couldn’t read that aloud right now. Try again.', res.status === 429 ? 503 : 502);
    }
    const audio = await res.arrayBuffer();
    // The response has no cost in it: charge the list price now, and the live
    // check (spend.ts) records what OpenRouter actually billed.
    await settle(env, key, toMicro(listPrice), 'done', null, ids);
    ctx.waitUntil(verifyNow(env, [{ key, ids }]));
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
  } catch (err) {
    await settle(env, key, 0, 'failed', null, ids);
    throw err;
  }
}
