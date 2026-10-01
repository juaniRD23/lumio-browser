// Streams one OpenRouter chat completion: yields text as it arrives and
// returns the whole reply (text, tool calls, finish reason, usage with cost).
import { AgentError, type Env } from './util.ts';
import { ceiling, type Model } from './models.ts';

export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
export type Reply = { content: string; calls: { id?: string; name: string; args: string }[]; finish: string | null; usage: Usage | null };

export class ProviderError extends AgentError {
  constructor(message: string, status = 502) { super(message, status, 'provider_unavailable'); }
}

// OpenRouter's ID for one generation, used to look up its official cost later.
export const GEN_ID = /^gen-[0-9A-Za-z-]{1,123}$/;

// `ids` collects the generation's ID as soon as it arrives (even if the reply
// breaks off later), so its cost can be checked against OpenRouter's records.
export async function* complete(env: Env, model: Model, body: Record<string, unknown>, ids?: string[]): AsyncGenerator<string, Reply> {
  if (!env.OPENROUTER_API_KEY) throw new AgentError('Lumio AI isn’t connected to its model right now.', 503, 'model_not_connected');
  const base = (env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://lumio-usa.online', 'X-Title': 'Lumio' },
      body: JSON.stringify({
        ...body,
        model: model.id,
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
        // Only providers that don't keep or train on what people send.
        provider: { max_price: ceiling(model), require_parameters: true, allow_fallbacks: true, data_collection: 'deny' },
      }),
    });
  } catch {
    throw new ProviderError('Couldn’t reach Lumio AI’s model. Try again.');
  }
  if (!res.ok || !res.body) throw new ProviderError('Lumio AI’s model is busy right now. Try again in a moment.', res.status === 429 ? 503 : 502);

  const out: Reply = { content: '', calls: [], finish: null, usage: null };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 1);
      if (!line.startsWith('data:')) continue; // comments and keep-alives
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (ids && typeof chunk.id === 'string' && GEN_ID.test(chunk.id) && !ids.includes(chunk.id)) ids.push(chunk.id);
      if (chunk.error) throw new ProviderError(chunk.error.message || 'The model stopped with an error.');
      if (chunk.usage) out.usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) out.finish = choice.finish_reason;
      const d = choice.delta || {};
      if (typeof d.content === 'string' && d.content) { out.content += d.content; yield d.content; }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        out.calls[i] ??= { name: '', args: '' };
        if (tc.id) out.calls[i].id = tc.id;
        if (tc.function?.name) out.calls[i].name += tc.function.name;
        if (tc.function?.arguments) out.calls[i].args += tc.function.arguments;
      }
    }
  }
  out.calls = out.calls.filter(Boolean);
  return out;
}

// Writes NDJSON lines to a streamed Response; `keep` lines are saved for replays.
export function ndjsonStream(base: Record<string, unknown> = {}) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const saved: string[] = [];
  return {
    response: new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } }),
    send(e: Record<string, unknown>, keep = false) {
      const line = JSON.stringify({ ...base, ...e }) + '\n';
      if (keep) saved.push(line);
      return writer.write(enc.encode(line)).catch(() => {});
    },
    saved: () => saved.join(''),
    close: () => writer.close().catch(() => {}),
  };
}
