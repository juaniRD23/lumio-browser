// Crash reports from Lumio Browser. They're opt-in ("Send crash reports to
// Lumio" in its Settings, off by default). POST /api/crash takes either:
//   - Crashpad's upload when a Lumio process crashes: multipart/form-data
//     (usually gzipped) with the minidump in `upload_file_minidump` and the
//     annotations Lumio sets (`version`, `platform`, `arch`, `channel`) plus
//     Electron's own (`process_type`, `_productName`, ...), or
//   - Lumio's own JSON report: a JavaScript error in its main process, or a
//     page or helper process that died.
// There's no account and no cookie, so anyone can send one. That's why each
// IP (an IPv6 /64) gets a few tries an hour (stored as a hash that changes
// every day and is cleared after a day), a dump must be a real minidump under
// the size limit, each IP and everyone together get a daily dump budget, and
// Crashpad's install ID (`guid`) is never kept, not even inside the dump.
// Text is scrubbed of web addresses, hosts, emails and file paths again here, in
// case an old or odd client sends some. Dumps go to R2 at
// crashes/<date>/<id>.dmp. A row in `crashes`
// holds what the owner's /admin page shows (GET /api/admin/crashes), grouped
// by version and signature. Reports are kept 90 days (crashCleanup, cron).
import type { User } from './auth.ts';
import { type Env, fail, json, randomHex, sameOrigin, sha256 } from './util.ts';

const MAX_UPLOAD = 4 * 1024 * 1024; // what Crashpad sends (usually gzipped)
const MAX_DUMP = 8 * 1024 * 1024; // the minidump once unzipped (a Mac Crashpad dump is usually well under 1 MB)
const MAX_JSON = 64 * 1024;
const PER_IP_HOUR = 20; // attempts, kept or refused, so junk can't keep the Worker busy either
// Past these, keep the row and drop the dump, so junk can't fill R2 or crowd out real dumps.
const DUMPS_PER_IP_DAY = 5;
const DUMPS_PER_DAY = 1000; // from everyone together
const DUMP_BYTES_PER_DAY = 1024 * 1024 * 1024;
const KEEP_DAYS = 90;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const PLATFORMS = ['darwin', 'win32', 'linux'];
const ARCHS = ['arm64', 'x64', 'ia32', 'arm'];
const CHANNELS = ['stable', 'beta', 'dev'];
const WHERE = ['page', 'ui', 'extension'];

type Crash = {
  version: string | null; platform: string | null; arch: string | null; channel: string | null;
  process_type: string | null; reason: string | null; signature: string; message: string | null; stack: string | null;
  dump?: Uint8Array;
};

const oneOf = (v: unknown, list: string[]) => (typeof v === 'string' && list.includes(v) ? v : null);
const versionOf = (v: unknown) => (typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$/.test(v) ? v : null);
// Process types, reasons and names: short words from Electron, nothing free-form.
const word = (v: unknown, max = 40) => (typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_. ()-]+$/.test(v) ? v : null);

// Web addresses, emails and file paths could say who someone is or what they
// were doing, so they never make it into a stored report.
export function scrub(text: unknown, max: number) {
  const s = String(text ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"()<>]*/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/(?<![\w.~-])(?:[A-Za-z]:|~)?(?:[\\/][^\\/'"():<>\r\n]+){2,}/g, '<path>');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
// Messages can also name a site without its scheme ("getaddrinfo ENOTFOUND
// mybank.example.com"), an IP address or a token (main/crash-reports.js does
// the same). Anything shaped like a host goes, even when it's really code; the
// stack still says where the bug is. Lumio's own file names (tabs.js) stay.
const CODE_FILES = /^(?:c?js|mjs|ts|json|node|html|css|map|asar|wasm|pak|plist|dylib|so|dll|exe|app|framework)$/i;
export function scrubHosts(text: string) {
  return text
    .replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){0,6}::[0-9a-f:]*[0-9a-f](?![\w:])/gi, '<ip>')
    .replace(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g, '<ip>')
    .replace(/(?<![\w$@.\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]*[a-z0-9])\.?(?![\w$-]|\.\w)/gi, (m, last) => (CODE_FILES.test(last) && !/\..*\./.test(m) ? m : '<host>'))
    .replace(/(?<![\w+\/=-])(?=[\w+\/=-]*\d)(?=[\w+\/=-]*[A-Za-z])[\w+\/=-]{24,}/g, '<token>');
}
// In a stack, "at fn (where)" frames keep their function names, which look
// like hosts (emitter.emit); only where they ran is scrubbed.
const scrubText = (text: unknown, max: number) => scrub(scrubHosts(scrub(text, Infinity)), max);
const scrubLine = (line: string) => {
  const m = /^(\s*at (?:.+? \()?)(.*?)(\)?)$/.exec(line);
  return m ? m[1] + scrubHosts(m[2]) + m[3] : scrubHosts(line);
};
const scrubStack = (text: unknown, max: number) => scrub(scrub(text, Infinity).split('\n').map(scrubLine).join('\n'), max);

// "TypeError at main/tabs.js:183 in update": the error and the first of
// Lumio's own frames, so the same bug groups together.
export function jsSignature(name: string, stack: string) {
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:(.+?) \()?((?:main|renderer|preload|node_modules)\/[^\s:()]+):(\d+)(?::\d+)?\)?$/.exec(line);
    if (m) return `${name} at ${m[2]}:${m[3]}${m[1] ? ` in ${m[1].replace(/^async /, '')}` : ''}`.slice(0, 200);
  }
  return name;
}

// ---------------------------------------------------------------- minidumps
// What a minidump says about the crash, without symbols: the exception and
// where it happened as module + offset ("EXC_BAD_ACCESS in Electron
// Framework+0x2a3f10"), which is the same for the same bug in one version.
const EXCEPTIONS: Record<string, Record<number, string>> = {
  darwin: { 1: 'EXC_BAD_ACCESS', 2: 'EXC_BAD_INSTRUCTION', 3: 'EXC_ARITHMETIC', 5: 'EXC_SOFTWARE', 6: 'EXC_BREAKPOINT', 10: 'EXC_CRASH', 11: 'EXC_RESOURCE', 12: 'EXC_GUARD', 0x43507378: 'DUMP_WITHOUT_CRASHING' },
  win32: { 0xc0000005: 'ACCESS_VIOLATION', 0xc0000409: 'STACK_BUFFER_OVERRUN', 0xc00000fd: 'STACK_OVERFLOW', 0x80000003: 'BREAKPOINT', 0xc000001d: 'ILLEGAL_INSTRUCTION', 0xc0000374: 'HEAP_CORRUPTION', 0xc0000094: 'INTEGER_DIVIDE_BY_ZERO', 0xe0000008: 'OUT_OF_MEMORY', 0x4000001f: 'BREAKPOINT' },
  linux: { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 11: 'SIGSEGV' },
};

export function readMinidump(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number | null) => (o != null && o >= 0 && o + 4 <= v.byteLength ? v.getUint32(o, true) : null);
  const u64 = (o: number | null) => (o != null && o >= 0 && o + 8 <= v.byteLength ? v.getBigUint64(o, true) : null);
  if (u32(0) !== 0x504d444d) return null; // "MDMP"
  const streams = u32(8) ?? 0;
  const dir = u32(12);
  let exception: number | null = null;
  let modules: number | null = null;
  for (let i = 0; i < Math.min(streams, 256) && dir != null; i++) {
    const type = u32(dir + i * 12);
    if (type === 6) exception = u32(dir + i * 12 + 8); // ExceptionStream
    if (type === 4) modules = u32(dir + i * 12 + 8); // ModuleListStream
  }
  const code = exception == null ? null : u32(exception + 8);
  const address = exception == null ? null : u64(exception + 24);
  let module: string | null = null;
  let offset: bigint | null = null;
  if (modules != null && address != null) {
    const count = Math.min(u32(modules) ?? 0, 4096);
    for (let i = 0; i < count; i++) {
      const m = modules + 4 + i * 108; // MINIDUMP_MODULE
      const base = u64(m);
      const size = u32(m + 8);
      if (base == null || size == null) break;
      if (address >= base && address < base + BigInt(size)) {
        module = moduleName(v, u32(m + 20));
        offset = address - base;
        break;
      }
    }
  }
  return { code, module, offset };
}

// Crashpad also writes the install's ID (the upload's `guid`) into the dump,
// in its MinidumpCrashpadInfo stream: version (4 bytes), report ID (16), then
// client ID (16). It's zeroed before the dump is stored, so stored dumps
// can't tie one install's crashes together either.
const CRASHPAD_INFO = 0x43500001;
export function forgetInstallId(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => (o >= 0 && o + 4 <= v.byteLength ? v.getUint32(o, true) : null);
  const streams = u32(8) ?? 0;
  const dir = u32(12);
  for (let i = 0; i < Math.min(streams, 256) && dir != null; i++) {
    if (u32(dir + i * 12) !== CRASHPAD_INFO) continue;
    const size = u32(dir + i * 12 + 4) ?? 0;
    const at = u32(dir + i * 12 + 8);
    if (at != null && size >= 36 && at + 36 <= bytes.byteLength) bytes.fill(0, at + 20, at + 36);
  }
  return bytes;
}

// A module's file name (never its folder, which can hold the user's name).
function moduleName(v: DataView, rva: number | null) {
  if (rva == null || rva + 4 > v.byteLength) return null;
  const len = Math.min(v.getUint32(rva, true), 2048, v.byteLength - rva - 4);
  let s = '';
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(v.getUint16(rva + 4 + i, true));
  const base = s.split(/[\\/]/).pop() || '';
  return /^[\w .+()-]{1,80}$/.test(base) ? base : 'a module';
}

function dumpSignature(platform: string | null, info: ReturnType<typeof readMinidump>) {
  if (!info || info.code == null) return { reason: null, signature: 'crash (no exception record)' };
  const reason = EXCEPTIONS[platform || '']?.[info.code] || `0x${info.code.toString(16).padStart(8, '0')}`;
  return { reason, signature: info.module ? `${reason} in ${info.module}+0x${info.offset!.toString(16)}` : `${reason} in an unknown module` };
}

// ---------------------------------------------------------------- receiving
async function readAll(stream: ReadableStream<Uint8Array> | null, max: number) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

const tooBig = () => fail('That crash report is too big.', 413, 'too_large');
const invalid = (why: string) => fail(why, 400, 'invalid_request');

// Crashpad's upload. It's gzipped unless the client was told not to; the bytes
// say so either way (in case something on the way already unzipped it).
async function fromCrashpad(request: Request, type: string): Promise<Crash | Response> {
  if (Number(request.headers.get('content-length') || 0) > MAX_UPLOAD) return tooBig();
  let body = await readAll(request.body, MAX_UPLOAD);
  if (!body) return tooBig();
  if (body[0] === 0x1f && body[1] === 0x8b) {
    body = await readAll(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_DUMP + 64 * 1024).catch(() => null);
    if (!body) return invalid('That crash report couldn’t be unzipped, or it’s too big.');
  }
  const form = await new Response(body, { headers: { 'content-type': type } }).formData().catch(() => null);
  if (!form) return invalid('That isn’t a crash report.');
  const field = (k: string) => { const x = form.get(k); return typeof x === 'string' ? x : null; };
  const product = field('_productName');
  if (product && product !== 'Lumio Browser') return invalid('That crash report isn’t from Lumio Browser.');
  const file = form.get('upload_file_minidump');
  if (!file || typeof file === 'string') return invalid('The crash report has no minidump.');
  if (file.size > MAX_DUMP) return tooBig();
  const dump = new Uint8Array(await file.arrayBuffer());
  const info = readMinidump(dump);
  if (!info) return invalid('That isn’t a minidump.');
  forgetInstallId(dump);
  const platform = oneOf(field('platform'), PLATFORMS);
  const { reason, signature } = dumpSignature(platform, info);
  return {
    version: versionOf(field('version')) || versionOf(field('_version')), platform, arch: oneOf(field('arch'), ARCHS), channel: oneOf(field('channel'), CHANNELS),
    process_type: word(field('process_type') || field('ptype'), 32), reason, signature, message: null, stack: null, dump,
  };
}

// Lumio's own report: { type: 'js', process, reason, name, message, stack }
// or { type: 'gone', process, reason, exitCode, where, name }.
async function fromJson(request: Request): Promise<Crash | Response> {
  const raw = await readAll(request.body, MAX_JSON);
  if (!raw) return tooBig();
  let r: Record<string, unknown>;
  try { r = JSON.parse(new TextDecoder().decode(raw)); } catch { return invalid('That isn’t a crash report.'); }
  if (!r || typeof r !== 'object') return invalid('That isn’t a crash report.');
  const base = { version: versionOf(r.version), platform: oneOf(r.platform, PLATFORMS), arch: oneOf(r.arch, ARCHS), channel: oneOf(r.channel, CHANNELS), process_type: word(r.process, 32) };
  const reason = word(r.reason);
  if (!reason) return invalid('The crash report needs a reason.');
  if (r.type === 'js') {
    const name = (typeof r.name === 'string' && /^[\w$.]{1,40}$/.test(r.name) && r.name) || 'Error';
    const stack = scrubStack(r.stack, 4000) || null;
    return { ...base, reason, signature: jsSignature(name, stack || ''), message: scrubText(`${name}: ${r.message ?? ''}`, 300), stack };
  }
  if (r.type === 'gone') {
    const where = oneOf(r.where, WHERE);
    const name = word(r.name, 60);
    const exit = Number.isInteger(r.exitCode) ? Number(r.exitCode) : null;
    const who = `${base.process_type || 'process'}${name ? ` (${name})` : ''}${where && where !== 'page' ? ` [${where}]` : ''}`;
    return { ...base, reason, signature: `${who} gone: ${reason}`, message: exit == null ? null : `exit code ${exit}`, stack: null };
  }
  return invalid('Unknown kind of crash report.');
}

// One IPv6 user usually has a whole /64 to pick addresses from, so that's what counts.
export function ipKey(ip: string | null) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const a = head ? head.split(':') : [];
  const b = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

const dumpKey = (id: string, at: number) => `crashes/${new Date(at).toISOString().slice(0, 10)}/${id}.dmp`;

// POST /api/crash (no account).
export async function receiveCrash(request: Request, env: Env, now = Date.now()) {
  // Lumio Browser and Crashpad never send an Origin; a web page always would.
  if (!sameOrigin(request)) return fail('Not allowed.', 403, 'forbidden');
  const ipHash = (await sha256(`lumio-crash|${new Date(now).toISOString().slice(0, 10)}|${ipKey(request.headers.get('cf-connecting-ip'))}`)).slice(0, 32);
  // Counted before anything else, and recorded first so parallel requests see each other.
  await env.DB.prepare('INSERT INTO crash_attempts (ip_hash, created_at) VALUES (?1, ?2)').bind(ipHash, now).run();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM crash_attempts WHERE ip_hash = ?1 AND created_at > ?2').bind(ipHash, now - HOUR).first<{ n: number }>();
  if ((recent?.n ?? 0) > PER_IP_HOUR) return fail('Too many crash reports. Try again later.', 429, 'rate_limited');

  const type = request.headers.get('content-type') || '';
  const crashpad = /^multipart\/form-data/i.test(type);
  if (!crashpad && !/^application\/json/i.test(type)) return fail('Send a crash report.', 415, 'unsupported');
  const crash = crashpad ? await fromCrashpad(request, type) : await fromJson(request);
  if (crash instanceof Response) return crash;

  const id = 'cr_' + randomHex(12);
  let hasDump = 0;
  if (crash.dump && env.FILES) {
    const today = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(dump_bytes), 0) AS bytes, COALESCE(SUM(ip_hash = ?2), 0) AS mine FROM crashes WHERE has_dump = 1 AND created_at >= ?1')
      .bind(now - DAY, ipHash).first<{ n: number; bytes: number; mine: number }>();
    if ((today?.n ?? 0) < DUMPS_PER_DAY && (today?.mine ?? 0) < DUMPS_PER_IP_DAY && (today?.bytes ?? 0) + crash.dump.byteLength <= DUMP_BYTES_PER_DAY) {
      await env.FILES.put(dumpKey(id, now), crash.dump, { httpMetadata: { contentType: 'application/octet-stream' } });
      hasDump = 1;
    }
  }
  await env.DB.prepare(`INSERT INTO crashes (id, created_at, version, platform, arch, channel, process_type, reason, has_dump, signature, message, stack, ip_hash, dump_bytes)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
    .bind(id, now, crash.version, crash.platform, crash.arch, crash.channel, crash.process_type, crash.reason, hasDump, crash.signature, crash.message, crash.stack, ipHash, hasDump ? crash.dump!.byteLength : 0).run();
  // Crashpad keeps the answer as the report's ID, as plain text.
  return crashpad ? new Response(id, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }) : json({ ok: true, id });
}

// ---------------------------------------------------------------- the owner (/admin)
const ownerOnly = (user: User) => (user.role === 'owner' ? null : json({ error: 'Not found.', code: 'not_found' }, 404));

type GroupRow = { version: string | null; signature: string; process_type: string | null; n: number; dumps: number; first_at: number; last_at: number; platforms: string | null; channels: string | null };
type CrashRow = { id: string; created_at: number; version: string | null; platform: string | null; arch: string | null; channel: string | null; process_type: string | null; reason: string | null; has_dump: number; signature: string; message: string | null; stack: string | null };

// GET /api/admin/crashes?days=30: the most common crashes (by version and
// signature), and the latest ones.
export async function listCrashes(request: Request, env: Env, user: User, now = Date.now()) {
  const denied = ownerOnly(user);
  if (denied) return denied;
  const days = Math.max(1, Math.min(KEEP_DAYS, Math.floor(Number(new URL(request.url).searchParams.get('days')) || 30)));
  const since = now - days * DAY;
  const totals = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?2), 0) AS day, COALESCE(SUM(has_dump), 0) AS dumps FROM crashes WHERE created_at >= ?1')
    .bind(since, now - DAY).first<{ n: number; day: number; dumps: number }>();
  const { results: groups } = await env.DB.prepare(`SELECT version, signature, process_type, COUNT(*) AS n, SUM(has_dump) AS dumps, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
      GROUP_CONCAT(DISTINCT platform) AS platforms, GROUP_CONCAT(DISTINCT channel) AS channels
    FROM crashes WHERE created_at >= ?1 GROUP BY version, signature, process_type ORDER BY n DESC, last_at DESC LIMIT 100`).bind(since).all<GroupRow>();
  const { results: recent } = await env.DB.prepare(`SELECT id, created_at, version, platform, arch, channel, process_type, reason, has_dump, signature, message, stack
    FROM crashes WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT 50`).bind(since).all<CrashRow>();
  const list = (s: string | null) => (s ? s.split(',').filter(Boolean).sort() : []);
  return json({
    days,
    totals: { reports: totals?.n ?? 0, last24h: totals?.day ?? 0, dumps: totals?.dumps ?? 0 },
    groups: groups.map((g) => ({ version: g.version, signature: g.signature, process: g.process_type, count: g.n, dumps: g.dumps, firstAt: g.first_at, lastAt: g.last_at, platforms: list(g.platforms), channels: list(g.channels) })),
    recent: recent.map((c) => ({
      id: c.id, at: c.created_at, version: c.version, platform: c.platform, arch: c.arch, channel: c.channel, process: c.process_type, reason: c.reason,
      signature: c.signature, message: c.message, stack: c.stack, dump: c.has_dump ? `/api/admin/crashes/${c.id}/dump` : null,
    })),
  });
}

// GET /api/admin/crashes/:id/dump: the minidump, to open with the matching symbols.
export async function crashDump(env: Env, user: User, id: string) {
  const denied = ownerOnly(user);
  if (denied) return denied;
  const row = await env.DB.prepare('SELECT created_at, has_dump FROM crashes WHERE id = ?1').bind(id).first<{ created_at: number; has_dump: number }>();
  const obj = row?.has_dump && env.FILES ? await env.FILES.get(dumpKey(id, row.created_at)) : null;
  if (!obj) return fail('Not found.', 404, 'not_found');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${id}.dmp"`, 'cache-control': 'no-store' } });
}

// Every few minutes (cron): forget IP hashes after a day and reports after 90 days.
export async function crashCleanup(env: Env, now = Date.now()) {
  await env.DB.prepare('UPDATE crashes SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?1').bind(now - DAY).run();
  await env.DB.prepare('DELETE FROM crash_attempts WHERE created_at < ?1').bind(now - DAY).run();
  const { results } = await env.DB.prepare('SELECT id, created_at, has_dump FROM crashes WHERE created_at < ?1 ORDER BY created_at LIMIT 500')
    .bind(now - KEEP_DAYS * DAY).all<{ id: string; created_at: number; has_dump: number }>();
  if (!results.length) return 0;
  const keys = results.filter((r) => r.has_dump).map((r) => dumpKey(r.id, r.created_at));
  if (keys.length && env.FILES) await env.FILES.delete(keys);
  await env.DB.batch(results.map((r) => env.DB.prepare('DELETE FROM crashes WHERE id = ?1').bind(r.id)));
  return results.length;
}
