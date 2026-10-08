// Image generation: the cheapest model on OpenRouter that makes good
// pictures, charged to the same allowance as everything else. Measured
// 2026-09-30: Gemini 3.1 Flash Lite Image $0.034 and ~3 s per picture
// (Gemini 2.5 Flash Image $0.039, GPT-5 Image Mini $0.042 and ~40 s).
import type { Plan } from './agent.ts';
import { GEN_ID, ProviderError } from './openrouter.ts';
import { verifyNow } from './spend.ts';
import { hold, LimitError, limits, settle, toMicro } from './usage.ts';
import { AgentError, type Env, fail, json, randomHex, sha256 } from './util.ts';

export const IMAGE_MODEL = {
  id: 'google/gemini-3.1-flash-lite-image',
  name: 'Gemini 3.1 Flash Lite Image',
  // Held while a picture is made (USD); the real cost is charged after.
  hold: 0.04,
};
export const ASPECTS = { square: '1:1', portrait: '2:3', landscape: '3:2' } as const;
export type Aspect = keyof typeof ASPECTS;

// `check`: the step and OpenRouter's ID for it, for the live cost check (spend.ts).
export type Made = { bytes: Uint8Array; mime: string; cost: number; text: string; check: { key: string; ids: string[] } };

function fromDataUrl(url: string) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) return null;
  return { mime: m[1], bytes: Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)) };
}

// Makes one image and bills it. Throws LimitError when the allowance can't cover it.
export async function makeImage(env: Env, user: { id: string; plan: Plan }, prompt: string, aspect: Aspect = 'square'): Promise<Made> {
  if (!env.OPENROUTER_API_KEY) throw new AgentError('Lumio AI isn’t connected to its model right now.', 503, 'model_not_connected');
  if (user.plan === 'free' || limits(user.plan).weekly < Math.ceil(IMAGE_MODEL.hold * 1_000_000)) throw new LimitError('Making pictures needs a paid Lumio plan (Go or higher). Upgrade to make pictures.');
  const key = await sha256(`image|${user.id}|${randomHex(8)}`);
  await hold(env, { key, owner: user.id, plan: user.plan, requestHash: key, kind: 'image', held: Math.ceil(IMAGE_MODEL.hold * 1_000_000) });
  let cost = 0;
  const ids: string[] = []; // OpenRouter's ID for the call, for the cost double-check
  try {
    const base = (env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://lumio-co.online', 'X-Title': 'Lumio' },
        body: JSON.stringify({
          model: IMAGE_MODEL.id,
          messages: [{ role: 'user', content: prompt }],
          modalities: ['image', 'text'],
          image_config: { aspect_ratio: ASPECTS[aspect] || '1:1' },
          usage: { include: true },
          provider: { data_collection: 'deny', allow_fallbacks: true },
        }),
      });
    } catch {
      throw new ProviderError('Couldn’t reach the image model. Try again.');
    }
    const data = await res.json<any>().catch(() => null);
    if (typeof data?.id === 'string' && GEN_ID.test(data.id)) ids.push(data.id);
    if (typeof data?.usage?.cost === 'number') cost = toMicro(data.usage.cost);
    if (!res.ok || data?.error) {
      const msg = String(data?.error?.message || '');
      if (/safety|policy|moderation|content/i.test(msg)) throw new AgentError('The image model declined that request. Try describing it differently.', 422, 'image_refused');
      throw new ProviderError('The image model is busy right now. Try again in a moment.', res.status === 429 ? 503 : 502);
    }
    const msg = data?.choices?.[0]?.message;
    const img = (msg?.images || []).map((i: any) => fromDataUrl(String(i?.image_url?.url || ''))).find(Boolean);
    if (!img) throw new AgentError('The image model didn’t return a picture. Try describing it differently.', 422, 'image_refused');
    await settle(env, key, cost || Math.ceil(IMAGE_MODEL.hold * 1_000_000), 'done', null, ids);
    return { ...img, cost, text: typeof msg?.content === 'string' ? msg.content : '', check: { key, ids } };
  } catch (err) {
    await settle(env, key, cost, 'failed', null, ids);
    throw err;
  }
}

export const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// POST /v1/images (Lumio Browser): { prompt, aspect } -> the picture as a data URL.
// The browser saves it on the computer; nothing is kept here.
export async function imageForBrowser(request: Request, env: Env, user: { id: string; plan: Plan }, ctx: ExecutionContext) {
  const body = await request.json<{ prompt?: unknown; aspect?: unknown }>().catch(() => null);
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > 4000) return fail('Describe the picture (up to 4,000 characters).', 400, 'invalid_request');
  const aspect = (Object.keys(ASPECTS) as Aspect[]).includes(body?.aspect as Aspect) ? (body!.aspect as Aspect) : 'square';
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM steps WHERE owner = ?1 AND kind = 'image' AND created_at >= ?2").bind(user.id, Date.now() - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 6) return fail('Slow down a little: too many pictures in the last minute.', 429, 'rate_limited');
  const img = await makeImage(env, user, prompt, aspect);
  ctx.waitUntil(verifyNow(env, [img.check]));
  return json({ image: `data:${img.mime};base64,${b64(img.bytes)}`, mime: img.mime, model: IMAGE_MODEL.name });
}
