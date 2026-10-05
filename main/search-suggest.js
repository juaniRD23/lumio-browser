// Search suggestions from the search engine while you type in the address
// bar (Settings › Privacy › "Autocomplete searches and URLs", on by
// default). Only ever for what looks like a search: never in Incognito,
// never for addresses, IPs, localhost or file paths, and never for text that
// looks private (emails, long numbers, passwords or keys). Requests go
// without cookies and are cancelled as you keep typing.
// Pure apart from the fetch it's given (tests/omnibox.test.mjs).
const { parseInput } = require('./omnibox');

const MAX_RESULTS = 5;
const TIMEOUT_MS = 1500;
const CACHE_MS = 2 * 60 * 1000;

// Text that may be personal: an email, a card/phone/ID number (9+ digits),
// "password: …", API keys and tokens, or a long word that mixes cases and
// digits like a password.
function looksPrivate(text) {
  const t = String(text || '');
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return true;
  if (/\d(?:[\s.-]?\d){8,}/.test(t)) return true;
  if (/\b(pass(word)?|passwd|pwd|pin|token|secret|api[\s_-]?key)\s*[:=]/i.test(t)) return true;
  if (/\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\./.test(t)) return true;
  for (const word of t.split(/\s+/)) {
    if (word.length >= 12 && /[a-z]/.test(word) && /[A-Z]/.test(word) && /\d/.test(word)) return true;
    if (word.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word)) return true;
  }
  return false;
}

// May this text go to the search engine?
function remoteAllowed(text, { incognito = false, enabled = true } = {}) {
  if (incognito || !enabled) return false;
  const t = String(text || '').trim();
  if (!t || t.length > 200) return false;
  if (t.startsWith('@')) return false; // Lumio's @tabs, @history…
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false; // any scheme: javascript:, file:, lumio:…
  if (/^(\/|~\/|\\\\|[a-z]:\\)/i.test(t)) return false; // a file path
  if (/(^|[\s/@])(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])([\s:/]|$)/i.test(t)) return false;
  if (!/\s/.test(t) && t.includes('/')) return false; // looks like an address (intranet/page)
  const parsed = parseInput(t);
  if (!parsed || !parsed.isSearch) return false;
  return !looksPrivate(t);
}

// An engine's answer -> up to 5 suggested searches. Engines answer in the
// OpenSearch format [query, [suggestions…], …] (Google also says what kind
// each is: only searches are kept, not addresses), or DuckDuckGo's older
// [{ phrase }, …].
function parseSuggestions(body, query) {
  let data;
  try { data = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  let list = [];
  if (Array.isArray(data) && Array.isArray(data[1])) {
    const types = data[4]?.['google:suggesttype'];
    list = data[1].filter((s, i) => !Array.isArray(types) || ['QUERY', 'ENTITY', 'PERSONALIZED_QUERY'].includes(types[i]));
  } else if (Array.isArray(data)) {
    list = data.map((x) => x?.phrase);
  }
  const q = String(query || '').trim().toLowerCase();
  const seen = new Set([q]);
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// A response's text, but no more than `max` characters (null if longer), so
// an endpoint or a site can't make Lumio read a huge answer.
async function readCapped(res, max = 65536) {
  if (Number(res.headers?.get?.('content-length')) > max * 4) return null;
  if (!res.body?.getReader) { const t = await res.text(); return t.length > max ? null : t; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > max) { reader.cancel().catch(() => {}); return null; }
  }
  return text + decoder.decode();
}

class RemoteSuggest {
  // fetchImpl: (url, init) => Response (Electron's net.fetch in the app).
  constructor({ fetchImpl, now = () => Date.now(), timeout = TIMEOUT_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeout = timeout;
    this.cache = new Map(); // "template\ntext" -> { at, list }
  }

  // Suggestions for `text` from the engine's suggest URL (with %s). Throws
  // AbortError when `signal` cancels it; other failures give [].
  async fetch(template, text, { signal } = {}) {
    if (!template || !template.includes('%s')) return [];
    const key = `${template}\n${text}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.list;
    const timer = AbortSignal.timeout(this.timeout);
    const sig = signal ? AbortSignal.any([signal, timer]) : timer;
    let list = [];
    try {
      const res = await this.fetchImpl(template.replace('%s', encodeURIComponent(text)), {
        signal: sig, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json, application/x-suggestions+json, text/javascript;q=0.9, */*;q=0.1' },
      });
      if (!res.ok) return [];
      const body = await readCapped(res);
      if (body === null) return [];
      list = parseSuggestions(body, text);
    } catch (err) {
      if (signal?.aborted) throw err;
      return [];
    }
    this.cache.set(key, { at: this.now(), list });
    if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    return list;
  }
}

module.exports = { RemoteSuggest, remoteAllowed, looksPrivate, parseSuggestions, readCapped };
