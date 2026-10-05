// Reports from Lumio Browser's Help › Report an issue… (main/help.js). Anyone
// can send one, signed in or not. Each holds only what the person chose to
// include: what happened, and if they ticked it, an email to reply to, the
// page's address, a screenshot and system info (versions and OS). Senders are
// limited to a few reports an hour (by account, or by a hash of their network
// address). The owner reads them on /admin; they're deleted after 180 days.
import type { User } from './auth.ts';
import { type Env, json, randomHex, sha256 } from './util.ts';

export const FEEDBACK_DAYS = 180;
const MAX_TEXT = 5000;
const MAX_SHOT = 1_400_000; // characters of the screenshot's data: URL (about 1 MB)
const LIMIT = { signedIn: 20, anonymous: 5 }; // reports an hour
const HOUR = 3600_000;

type Body = { description?: unknown; email?: unknown; url?: unknown; screenshot?: unknown; system?: unknown };
type Row = { id: string; user_id: string | null; account_email: string | null; email: string | null; description: string; url: string | null; system: string | null; has_shot: number; created_at: number };

const bad = (error: string, status = 400, code = 'invalid_request') => json({ error, code }, status);

// System info: a few short strings, nothing nested.
function cleanSystem(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v).slice(0, 12)) {
    if (/^[a-z][a-zA-Z]{0,30}$/.test(k) && (typeof val === 'string' || typeof val === 'number')) out[k] = String(val).slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

// POST /api/feedback
export async function postFeedback(request: Request, env: Env, user: User | null, now = Date.now()) {
  const raw = await request.text();
  if (raw.length > MAX_SHOT + 60_000) return bad('That report is too big. Leave out the screenshot and try again.', 413, 'too_large');
  let body: Body;
  try { body = JSON.parse(raw); } catch { return bad('That report couldn’t be read.'); }
  if (!body || typeof body !== 'object') return bad('That report couldn’t be read.');
  const description = String(body.description ?? '').trim().slice(0, MAX_TEXT);
  if (description.length < 3) return bad('Describe the issue first.');
  const email = typeof body.email === 'string' && /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,40}$/.test(body.email.trim()) ? body.email.trim() : null;
  const url = typeof body.url === 'string' && /^https?:\/\/\S+$/.test(body.url) ? body.url.slice(0, 2000) : null;
  let screenshot: string | null = null;
  if (body.screenshot != null) {
    if (typeof body.screenshot !== 'string' || body.screenshot.length > MAX_SHOT || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(body.screenshot)) {
      return bad('The screenshot couldn’t be read. Try again without it.');
    }
    screenshot = body.screenshot;
  }
  const system = cleanSystem(body.system);

  const sender = user ? `u:${user.id}` : `ip:${await sha256(`lumio-feedback|${request.headers.get('cf-connecting-ip') || 'unknown'}`)}`;
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE sender = ?1 AND created_at > ?2').bind(sender, now - HOUR).first<{ n: number }>();
  if ((recent?.n ?? 0) >= (user ? LIMIT.signedIn : LIMIT.anonymous)) return bad('You’ve sent a lot of reports in a short time. Try again in an hour.', 429, 'rate_limited');

  const id = `fb_${randomHex(12)}`;
  await env.DB.prepare(`INSERT INTO feedback (id, user_id, sender, email, description, url, screenshot, system, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
    .bind(id, user?.id ?? null, sender, email, description, url, screenshot, system ? JSON.stringify(system) : null, now).run();
  return json({ ok: true, id });
}

// ---------------------------------------------------------------- the owner (/admin)
const ownerOnly = (user: User) => (user.role === 'owner' ? null : json({ error: 'Not found.', code: 'not_found' }, 404));

// GET /api/admin/feedback: the newest 100 reports (screenshots on request).
export async function listFeedback(env: Env, user: User) {
  const denied = ownerOnly(user);
  if (denied) return denied;
  const { results } = await env.DB.prepare(`SELECT f.id, f.user_id, u.email AS account_email, f.email, f.description, f.url, f.system,
    CASE WHEN f.screenshot IS NULL THEN 0 ELSE 1 END AS has_shot, f.created_at
    FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 100`).all<Row>();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback').first<{ n: number }>();
  return json({
    total: total?.n ?? 0,
    reports: results.map((r) => ({
      id: r.id,
      at: r.created_at,
      description: r.description,
      email: r.email,
      account: r.account_email,
      url: r.url,
      system: r.system ? JSON.parse(r.system) : null,
      screenshot: !!r.has_shot,
    })),
  });
}

// GET /api/admin/feedback/:id/screenshot
export async function feedbackScreenshot(env: Env, user: User, id: string) {
  const denied = ownerOnly(user);
  if (denied) return denied;
  const row = await env.DB.prepare('SELECT screenshot FROM feedback WHERE id = ?1').bind(id).first<{ screenshot: string | null }>();
  const m = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(row?.screenshot || '');
  if (!m) return json({ error: 'Not found.', code: 'not_found' }, 404);
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': m[1], 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}

// DELETE /api/admin/feedback/:id
export async function deleteFeedback(env: Env, user: User, id: string) {
  const denied = ownerOnly(user);
  if (denied) return denied;
  const r = await env.DB.prepare('DELETE FROM feedback WHERE id = ?1').bind(id).run();
  return json({ ok: !!r.meta.changes });
}

// Cron: reports older than 180 days go.
export async function feedbackCleanup(env: Env, now = Date.now()) {
  await env.DB.prepare('DELETE FROM feedback WHERE created_at < ?1').bind(now - FEEDBACK_DAYS * 24 * HOUR).run();
}
