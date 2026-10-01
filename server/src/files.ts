// Files in Lumio Chat: pictures and documents people attach, images Lumio
// makes and documents it writes. Picture bytes live in R2 (`files/<id>`);
// a document is kept as its text (read in the browser when it's attached:
// PDF, Word, slides, sheets, code...). Only the owner can read a file.
import type { User } from './auth.ts';
import { b64 } from './images.ts';
import { officeKind, officeText } from './office.ts';
import { type Env, fail, json, randomHex } from './util.ts';

export const MAX_FILES_PER_MESSAGE = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_OFFICE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 300_000;
const UPLOADS_PER_DAY = 300;
const DAY = 86400_000;

export type FileRow = {
  id: string; user_id: string; chat_id: string | null; kind: 'image' | 'text' | 'document';
  name: string; mime: string; size: number; text: string | null; meta: string | null; created_at: number;
};

export const DOC_FORMATS = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', html: 'text/html' } as const;
export type DocFormat = keyof typeof DOC_FORMATS;

// What the page needs to show a file (never the text of a big document).
export function publicFile(f: FileRow) {
  const meta = f.meta ? JSON.parse(f.meta) : {};
  return { id: f.id, kind: f.kind, name: f.name, mime: f.mime, size: f.size, ...meta, ...(f.kind === 'image' ? { url: `/api/files/${f.id}` } : {}) };
}

function imageType(bytes: Uint8Array) {
  const h = (n: number) => bytes[n];
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4e && h(3) === 0x47) return 'image/png';
  if (h(0) === 0xff && h(1) === 0xd8 && h(2) === 0xff) return 'image/jpeg';
  if (h(0) === 0x52 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x46 && h(8) === 0x57 && h(9) === 0x45 && h(10) === 0x42 && h(11) === 0x50) return 'image/webp';
  if (h(0) === 0x47 && h(1) === 0x49 && h(2) === 0x46) return 'image/gif';
  return null;
}

const cleanName = (n: unknown, fallback: string) => String(n || fallback).replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || fallback;

export async function saveImage(env: Env, userId: string, bytes: Uint8Array, { name, chatId = null, meta = {} }: { name: string; chatId?: string | null; meta?: Record<string, unknown> }) {
  const mime = imageType(bytes);
  if (!mime) throw new Error('not an image');
  const id = 'f_' + randomHex(12);
  await env.FILES!.put(`files/${id}`, bytes, { httpMetadata: { contentType: mime } });
  const row: FileRow = { id, user_id: userId, chat_id: chatId, kind: 'image', name, mime, size: bytes.length, text: null, meta: JSON.stringify(meta), created_at: Date.now() };
  await insert(env, row);
  return row;
}

export async function saveText(env: Env, userId: string, { kind, name, mime, text, chatId = null, meta = {} }: { kind: 'text' | 'document'; name: string; mime: string; text: string; chatId?: string | null; meta?: Record<string, unknown> }) {
  const row: FileRow = { id: 'f_' + randomHex(12), user_id: userId, chat_id: chatId, kind, name, mime, size: new TextEncoder().encode(text).length, text, meta: JSON.stringify(meta), created_at: Date.now() };
  await insert(env, row);
  return row;
}

async function insert(env: Env, f: FileRow) {
  await env.DB.prepare('INSERT INTO files (id, user_id, chat_id, kind, name, mime, size, text, meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(f.id, f.user_id, f.chat_id, f.kind, f.name, f.mime, f.size, f.text, f.meta, f.created_at).run();
}

// POST /api/files: a picture (its bytes, resized in the browser), a Word,
// PowerPoint or Excel file (read here), or a document's text as JSON
// { name, mime, text, pages? } (PDFs and text files are read in the browser).
export async function upload(request: Request, env: Env, user: User) {
  if (!env.FILES) return fail('File uploads aren’t set up yet.', 503, 'files_unavailable');
  const now = Date.now();
  // Forget attachments that were never sent.
  const stale = await env.DB.prepare('SELECT id, kind FROM files WHERE user_id = ?1 AND chat_id IS NULL AND created_at < ?2 LIMIT 50').bind(user.id, now - DAY).all<{ id: string; kind: string }>();
  if (stale.results.length) await removeFiles(env, stale.results);
  const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id = ?1 AND created_at >= ?2').bind(user.id, now - DAY).first<{ n: number }>();
  if ((today?.n ?? 0) >= UPLOADS_PER_DAY) return fail('That’s a lot of files today. Try again tomorrow.', 429, 'rate_limited');

  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (type === 'application/json') {
    const body = await request.json<{ name?: string; mime?: string; text?: string; pages?: number }>().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) return fail('That file has no text Lumio can read.', 400, 'empty_file');
    const row = await saveText(env, user.id, {
      kind: 'text', name: cleanName(body?.name, 'file.txt'), mime: String(body?.mime || 'text/plain').slice(0, 120), text: text.slice(0, MAX_TEXT_CHARS),
      meta: { ...(Number.isSafeInteger(body?.pages) ? { pages: body!.pages } : {}), ...(text.length > MAX_TEXT_CHARS ? { truncated: true } : {}) },
    });
    return json({ file: publicFile(row) });
  }
  let name = 'file';
  try { name = decodeURIComponent(request.headers.get('x-file-name') || 'file'); } catch { /* keep default */ }
  // Word, PowerPoint and Excel files: read here.
  const office = officeKind(name, type);
  if (office) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_OFFICE_BYTES) return fail('Files can be up to 25 MB.', 413, 'file_too_large');
    let got;
    try { got = await officeText(bytes, office); } catch { return fail('Lumio couldn’t read that file. Is it a real Word, PowerPoint or Excel file?', 415, 'unreadable_file'); }
    if (!got.text.trim()) return fail('That file has no text Lumio can read.', 400, 'empty_file');
    const row = await saveText(env, user.id, {
      kind: 'text', name: cleanName(name, `file.${office}`), mime: type || 'application/octet-stream', text: got.text.slice(0, MAX_TEXT_CHARS),
      meta: { ...(office === 'pptx' ? { slides: got.parts } : office === 'xlsx' ? { sheets: got.parts } : {}), ...(got.text.length > MAX_TEXT_CHARS ? { truncated: true } : {}) },
    });
    return json({ file: publicFile(row) });
  }
  if (!type.startsWith('image/')) return fail('Send a picture, an Office file, or a document’s text.', 415, 'unsupported_file');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return fail('Pictures can be up to 8 MB.', 413, 'file_too_large');
  if (!imageType(bytes)) return fail('That picture format isn’t supported. Use PNG, JPEG, WebP or GIF.', 415, 'unsupported_file');
  const row = await saveImage(env, user.id, bytes, { name: cleanName(name, 'image') });
  return json({ file: publicFile(row) });
}

// GET /api/files/:id: the owner's picture, or a made document's content.
export async function download(env: Env, user: User, id: string) {
  const f = await env.DB.prepare('SELECT * FROM files WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first<FileRow>();
  if (!f) return fail('File not found.', 404, 'not_found');
  if (f.kind === 'image') {
    const obj = await env.FILES?.get(`files/${f.id}`);
    if (!obj) return fail('File not found.', 404, 'not_found');
    return new Response(obj.body, { headers: { 'content-type': f.mime, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
  }
  return json({ ...publicFile(f), text: f.text });
}

export async function filesFor(env: Env, userId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await env.DB.prepare(`SELECT * FROM files WHERE user_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`).bind(userId, ...ids).all<FileRow>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is FileRow => !!r);
}

// A picture as a data URL for the model.
export async function imageDataUrl(env: Env, f: FileRow) {
  const obj = await env.FILES?.get(`files/${f.id}`);
  if (!obj) return null;
  return `data:${f.mime};base64,${b64(new Uint8Array(await obj.arrayBuffer()))}`;
}

export async function removeFiles(env: Env, files: { id: string; kind: string }[]) {
  const pics = files.filter((f) => f.kind === 'image').map((f) => `files/${f.id}`);
  if (pics.length && env.FILES) await env.FILES.delete(pics);
  for (const f of files) await env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(f.id).run();
}

// POST /v1/extract (Lumio Browser): the text of a Word, PowerPoint or Excel
// file the person attached. Nothing is kept.
export async function extract(request: Request) {
  let name = 'file';
  try { name = decodeURIComponent(request.headers.get('x-file-name') || 'file'); } catch { /* keep default */ }
  const kind = officeKind(name, request.headers.get('content-type') || '');
  if (!kind) return fail('Send a Word, PowerPoint or Excel file.', 415, 'unsupported_file');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_OFFICE_BYTES) return fail('Files can be up to 25 MB.', 413, 'file_too_large');
  try {
    const got = await officeText(bytes, kind);
    return json({ text: got.text.slice(0, MAX_TEXT_CHARS), parts: got.parts, kind });
  } catch {
    return fail('Lumio couldn’t read that file. Is it a real Word, PowerPoint or Excel file?', 415, 'unreadable_file');
  }
}
