// Omnibox logic: decide between URL and search, and build suggestions.
// Pure functions, no Electron imports (unit-tested in tests/omnibox.test.mjs).
const { answerFor } = require('./omnibox-answers');

const SCHEME_RE = /^(https?|file|lumio|about|view-source|data|mailto):/i;
const HOST_PORT_PATH = /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3})(:\d{1,5})?([/?#].*)?$/i;
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}\.?(:\d{1,5})?([/?#].*)?$/i;

function searchUrl(text, template) {
  return template.replace('%s', encodeURIComponent(text));
}

function parseInput(raw, searchTemplate = 'https://www.google.com/search?q=%s') {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^javascript:/i.test(text)) return { url: searchUrl(text, searchTemplate), isSearch: true };
  // chrome://history, chrome://extensions etc. open Lumio's own pages
  // (chrome://flags is Lumio's short list of experiments).
  const page = /^(?:chrome|about):\/*(history|downloads|bookmarks|extensions|settings|passwords|newtab|version|flags)\/?(.*)$/i.exec(text);
  if (page) return { url: `lumio://${page[1].toLowerCase().replace(/^flags$/, 'flags-lite')}/${page[2]}`, isSearch: false };
  if (/^chrome-extension:\/\/[a-p]{32}(\/|$)/.test(text)) return { url: text, isSearch: false };
  if (SCHEME_RE.test(text)) {
    if (/^(https?|file|lumio):/i.test(text)) {
      try { return { url: new URL(text).href, isSearch: false }; } catch { /* fall through to search */ }
    } else {
      return { url: text, isSearch: false };
    }
  }
  if (!/\s/.test(text)) {
    if (HOST_PORT_PATH.test(text)) return { url: 'http://' + text, isSearch: false };
    if (DOMAIN_RE.test(text) && !/^\d+(\.\d+)+$/.test(text)) {
      try { return { url: new URL('https://' + text).href, isSearch: false }; } catch { /* search */ }
    }
  }
  return { url: searchUrl(text, searchTemplate), isSearch: true };
}

function displayUrl(url) {
  return String(url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

// ---------------------------------------------------------------- frecency
// How much one visit counts by its age (the buckets Firefox uses).
const DAY = 86_400_000;
function visitWeight(age) {
  const d = age / DAY;
  return d <= 4 ? 100 : d <= 14 ? 70 : d <= 31 ? 50 : d <= 90 ? 30 : 10;
}
const boost = (score) => Math.min(8, 2 * Math.log2(1 + score / 50));
// "https://www.github.com/a?b" -> scheme, host (with port), and what follows "/" (empty on a site's front page).
const ORIGIN_RE = /^(https?:)\/\/(?:[^@/?#]*@)?([^/?#]+)\/?([^#]*)/i;
const hostKey = (host) => host.toLowerCase().replace(/^www\./, '');
// What matching compares, in lowercase.
const lowered = (url, title) => ({ bare: displayUrl(url).toLowerCase(), u: String(url).toLowerCase(), t: String(title || '').toLowerCase() });

// History -> what each page and each site is worth: visits × recency, with
// addresses typed into the address bar counting again on top. `typed` is
// { url: { n: times typed, t: last time } } (main/omnibox-service.js).
function buildIndex(history = [], typed = {}, now = Date.now()) {
  const urls = new Map();
  for (const h of history) {
    if (!h || typeof h.url !== 'string') continue;
    let e = urls.get(h.url);
    if (!e) { e = { url: h.url, title: '', visits: 0, last: 0, score: 0, typed: 0 }; urls.set(h.url, e); }
    e.visits++;
    e.score += visitWeight(now - (h.time || 0));
    if ((h.time || 0) >= e.last) { e.last = h.time || 0; if (h.title) e.title = h.title; }
    if (h.favicon) e.favicon = h.favicon; // the site's icon for its row, from any visit
  }
  const typedElsewhere = []; // typed, then redirected (example.com -> www.example.com/)
  for (const [url, t] of Object.entries(typed || {})) {
    if (!(t?.n > 0)) continue;
    const e = urls.get(url);
    if (!e) { typedElsewhere.push([url, t]); continue; }
    e.typed = t.n;
    e.score += t.n * visitWeight(now - (t.t || 0));
  }
  const hosts = new Map(); // "github.com" -> the site as a whole
  for (const e of urls.values()) {
    const m = ORIGIN_RE.exec(e.url); // cheaper than new URL() for 20,000 pages
    if (!m) continue;
    const key = hostKey(m[2]);
    const root = `${m[1].toLowerCase()}//${m[2]}/`;
    let s = hosts.get(key);
    if (!s) { s = { host: key, url: root, title: '', visits: 0, last: 0, score: 0, typed: 0 }; hosts.set(key, s); }
    s.visits += e.visits;
    s.score += e.score;
    s.typed += e.typed;
    if (e.last >= s.last) { s.last = e.last; s.url = root; }
    if (!m[3] && e.title) s.title = e.title;
  }
  // It still counts for the site, if the site is in history.
  for (const [url, t] of typedElsewhere) {
    const m = ORIGIN_RE.exec(url);
    const s = m && hosts.get(hostKey(m[2]));
    if (s) { s.typed += t.n; s.score += t.n * visitWeight(now - (t.t || 0)); }
  }
  // Lowercased once here, not on every keystroke.
  for (const e of urls.values()) e.text = lowered(e.url, e.title);
  return { urls, hosts, list: [...urls.values()].sort((a, b) => b.score - a.score) };
}

// Inline autocomplete: the rest of the best address that starts with what's
// typed, shown selected after the caret. Kept to sites and addresses typed
// before or visited often, and only ever completes from the start.
function inlineMatch(raw, index) {
  const q = String(raw || '').toLowerCase();
  if (!q || /\s/.test(q) || q.length > 200 || /^[a-z][a-z0-9+.-]*:/.test(q) || q.startsWith('www.')) return null;
  let best = null;
  if (!q.includes('/')) {
    for (const s of index.hosts.values()) {
      if (s.host.length <= q.length || !s.host.startsWith(q) || !(s.typed >= 1 || s.visits >= 4)) continue;
      if (!best || s.score > best.score) best = s;
    }
    return best && { url: best.url, title: best.title || best.host, completion: best.host.slice(q.length) };
  }
  for (const e of index.urls.values()) {
    const { bare } = e.text;
    if (bare.length <= q.length || !bare.startsWith(q) || !(e.typed >= 1 || e.visits >= 3)) continue;
    if (!best || e.score > best.score) best = e;
  }
  return best && { url: best.url, title: best.title || displayUrl(best.url), completion: displayUrl(best.url).slice(q.length) };
}

// How well a page matches every word typed (0: it doesn't).
function matchScore(terms, url, title, text = lowered(url, title)) {
  const { bare, u, t } = text;
  let score = 0;
  for (const [i, term] of terms.entries()) {
    const inUrl = i === 0 && bare.startsWith(term) ? 12 : u.includes(term) ? 5 : 0;
    const inTitle = t.startsWith(term) || t.includes(' ' + term) ? 7 : t.includes(term) ? 4 : 0;
    if (!inUrl && !inTitle) return 0;
    score += inUrl + inTitle;
  }
  return score;
}

// ---------------------------------------------------------------- actions
// Things the browser can do, offered when the words match (Chrome's Actions).
const ACTIONS = [
  { action: 'clearData', title: 'Clear browsing data', words: ['clear browsing data', 'clear history', 'clear cache', 'clear cookies', 'delete browsing data', 'delete history', 'delete cookies', 'erase history'] },
  { action: 'passwords', title: 'Manage passwords', words: ['manage passwords', 'passwords', 'password manager', 'saved passwords', 'show passwords'] },
  { action: 'settings', title: 'Open settings', words: ['settings', 'open settings', 'browser settings', 'lumio settings', 'preferences'] },
  { action: 'incognito', title: 'New incognito window', words: ['incognito', 'new incognito window', 'incognito window', 'private window', 'private browsing'] },
];
function matchActions(raw) {
  const q = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length < 4) return [];
  return ACTIONS.filter((a) => a.words.some((w) => w.startsWith(q))).map(({ action, title }) => ({ type: 'action', title, action }));
}

// ---------------------------------------------------------------- suggestions
const searchFor = (engine, text) => engine.url.replace('%s', encodeURIComponent(text));

// One kind of result only (@tabs, @bookmarks, @history, @lumio).
function scoped(text, scope, { tabs = [], bookmarks = [], limit = 8 }, index) {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  const rank = (list, urlOf, titleOf, textOf = () => undefined) => (terms.length
    ? list.map((x) => [x, matchScore(terms, urlOf(x), titleOf(x), textOf(x))]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([x]) => x)
    : list);
  if (scope === 'lumio') return text ? [{ type: 'ai', title: text }] : [];
  if (scope === 'tabs') {
    return rank(tabs, (t) => t.url, (t) => t.title).slice(0, limit)
      .map((t) => ({ type: 'tab', title: t.title || displayUrl(t.url), url: t.url, tabId: t.tabId, windowId: t.windowId }));
  }
  if (scope === 'bookmarks') {
    return rank(bookmarks.slice().reverse(), (b) => b.url, (b) => b.title).slice(0, limit)
      .map((b) => ({ type: 'bookmark', title: b.title || displayUrl(b.url), url: b.url }));
  }
  if (scope === 'history') {
    const recent = terms.length ? index.list : [...index.urls.values()].sort((a, b) => b.last - a.last);
    const out = rank(recent, (e) => e.url, (e) => e.title, (e) => e.text).slice(0, text ? limit - 1 : limit)
      .map((e) => ({ type: 'history', title: e.title || displayUrl(e.url), url: e.url, removable: true }));
    if (text) out.push({ type: 'search', title: text, url: `lumio://history/?q=${encodeURIComponent(text)}`, hint: 'Search history' });
    return out;
  }
  return [];
}

// The rows under the address bar for what's typed. Options:
//  history, bookmarks, tabs (open tabs elsewhere: { tabId, windowId, title, url }),
//  typed (see buildIndex) or index (built once), searchTemplate,
//  mode: a site search engine ({ name, url }) or { scope } while a chip shows,
//  keywords: [{ keyword, chip }] to offer "Search YouTube" when one is typed,
//  remote: the search engine's suggestions, inline: false after a Backspace.
function suggest(raw, o = {}) {
  const text = String(raw || '').trim();
  const index = o.index || buildIndex(o.history || [], o.typed);
  const limit = o.limit || 8;
  const mode = o.mode || null;
  if (mode?.scope) return scoped(text, mode.scope, o, index);
  if (!text) return [];
  if (mode?.url) {
    return [
      { type: 'search', title: text, url: searchFor(mode, text), hint: `Search ${mode.name}` },
      ...(o.remote || []).filter((s) => s.toLowerCase() !== text.toLowerCase()).map((s) => ({ type: 'search', title: s, url: searchFor(mode, s), remote: true })),
    ].slice(0, limit);
  }

  const parsed = parseInput(text, o.searchTemplate);
  const out = [];
  const inline = o.inline === false ? null : inlineMatch(raw, index);
  if (inline) out.push({ type: 'history', title: inline.title, url: inline.url, inline: inline.completion });
  out.push(parsed.isSearch ? { type: 'search', title: text, url: parsed.url } : { type: 'url', title: displayUrl(parsed.url), url: parsed.url });

  const q = text.toLowerCase();
  if (!/\s/.test(q)) {
    const kw = (o.keywords || []).find((k) => !k.scope && k.keyword.toLowerCase() === q);
    if (kw) out.push({ type: 'keyword', title: kw.chip, keyword: kw.keyword });
    if (q.startsWith('@')) for (const k of (o.keywords || []).filter((x) => x.scope && x.keyword.startsWith(q))) out.push({ type: 'keyword', title: k.chip, keyword: k.keyword, scope: k.scope });
  }
  if (o.answers !== false) {
    const a = answerFor(text);
    if (a) out.push({ type: 'answer', title: a.title, answer: a.answer });
  }
  out.push(...matchActions(text).slice(0, 1));

  // Open tabs, bookmarks and history, best first; an open page is offered as
  // its tab. Rows are only made for the best few (history can be 20,000 pages).
  const terms = q.split(/\s+/).filter(Boolean);
  // The site's icon, from the bookmark or tab or any visit that has one.
  const icon = (url, item) => {
    const favicon = item?.favicon || index.urls.get(url)?.favicon || (o.bookmarks || []).find((b) => b.url === url && b.favicon)?.favicon;
    return favicon ? { favicon } : {};
  };
  const scored = new Map(); // url -> { score, row() }
  const consider = (url, m, extra, row, tab = false) => {
    if (!m) return;
    const e = index.urls.get(url);
    const score = m + extra + (e ? boost(e.score) : 0);
    const prev = scored.get(url);
    if (!prev || score > prev.score || tab) scored.set(url, { score: Math.max(score, prev?.score || 0), row });
  };
  for (const e of index.urls.values()) {
    consider(e.url, matchScore(terms, e.url, e.title, e.text), 0, () => ({ type: 'history', title: e.title || displayUrl(e.url), url: e.url, removable: true, ...icon(e.url) }));
  }
  for (const b of o.bookmarks || []) consider(b.url, matchScore(terms, b.url, b.title), 6, () => ({ type: 'bookmark', title: b.title || displayUrl(b.url), url: b.url, ...icon(b.url, b) }));
  for (const t of o.tabs || []) consider(t.url, matchScore(terms, t.url, t.title), 10, () => ({ type: 'tab', title: t.title || displayUrl(t.url), url: t.url, tabId: t.tabId, windowId: t.windowId, ...icon(t.url, t) }), true);
  // Leave room for up to four of the search engine's suggestions.
  const remote = (o.remote || []).filter((s) => s.toLowerCase() !== q);
  const localMax = limit - Math.min(remote.length, 4);
  for (const [url, { row }] of [...scored].sort((a, b) => b[1].score - a[1].score)) {
    if (out.length >= localMax) break;
    if (out.some((r) => r.url === url && r.type !== 'search')) continue;
    out.push(row());
  }
  for (const s of remote) {
    if (out.length >= limit) break;
    out.push({ type: 'search', title: s, url: searchFor({ url: o.searchTemplate || 'https://www.google.com/search?q=%s' }, s), remote: true });
  }
  if (parsed.isSearch) out.push({ type: 'ai', title: text });
  return out;
}

// Zero-suggest: when the address bar is empty, the pages visited most (at
// most two per site).
function zeroSuggest(index, { exclude = '', limit = 6 } = {}) {
  const perHost = new Map();
  const out = [];
  for (const e of index.list) {
    if (out.length >= limit) break;
    if (e.url === exclude) continue;
    let host;
    try { host = new URL(e.url).host; } catch { continue; }
    const n = perHost.get(host) || 0;
    if (n >= 2) continue;
    perHost.set(host, n + 1);
    out.push({ type: 'history', title: e.title || displayUrl(e.url), url: e.url, removable: true });
  }
  return out;
}

// Copied text that's a web address, for the "Link you copied" row: never
// text with spaces, other schemes, or a username and password in it.
function clipboardLink(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 2048 || /\s/.test(text)) return null;
  const parsed = parseInput(text);
  if (!parsed || parsed.isSearch) return null;
  let u;
  try { u = new URL(parsed.url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  return u.href;
}

// Ctrl+Enter: "lumio" -> "www.lumio.com" (adds what's missing).
function withWwwCom(raw) {
  const text = String(raw || '').trim();
  if (!text || /\s/.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  const slash = text.search(/[/?#]/);
  const host = slash < 0 ? text : text.slice(0, slash);
  const rest = slash < 0 ? '' : text.slice(slash);
  if (!host.includes('.')) return `www.${host}.com${rest}`;
  if (/^www\.[^.]+$/i.test(host)) return `${host}.com${rest}`;
  return text;
}

function topSites(history = [], n = 8) {
  const counts = new Map();
  for (const h of history) {
    let key;
    try { key = new URL(h.url).origin; } catch { continue; }
    const c = counts.get(key) || { url: key + '/', title: h.title, count: 0, time: 0 };
    c.count += 1;
    if (h.time > c.time) { c.time = h.time; if (new URL(h.url).pathname === '/') c.title = h.title; }
    counts.set(key, c);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || b.time - a.time)
    .slice(0, n)
    .map(({ url, title }) => ({ url, title: title || displayUrl(url) }));
}

module.exports = { parseInput, suggest, topSites, displayUrl, buildIndex, inlineMatch, matchActions, zeroSuggest, withWwwCom, clipboardLink, visitWeight };
