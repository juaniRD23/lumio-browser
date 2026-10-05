// Search engines and site search: the four built-in engines (store.js), the
// ones people add in Settings › Search engine (a name, a shortcut keyword and
// a URL with %s), and ones found on websites through OpenSearch (kept
// inactive until turned on). Saved in settings: searchEngine (the default's
// id), searchEngines (added ones, synced) and searchEnginesFound (found on
// sites, this computer only). Pure functions, no Electron imports
// (tests/search-engines.test.mjs).
const { SEARCH_ENGINES } = require('./store');

// What each built-in engine answers while you type, and its shortcut.
const BUILTIN_EXTRA = {
  google: { keyword: 'google.com', suggestUrl: 'https://suggestqueries.google.com/complete/search?client=chrome&ie=UTF-8&oe=UTF-8&q=%s' },
  duckduckgo: { keyword: 'duckduckgo.com', suggestUrl: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  bing: { keyword: 'bing.com', suggestUrl: 'https://api.bing.com/osjson.aspx?query=%s' },
  brave: { keyword: 'search.brave.com', suggestUrl: 'https://search.brave.com/api/suggest?q=%s' },
};

// Site search that comes ready to use ("yt cats" searches YouTube). They're
// ordinary entries: people can edit or delete them.
const SITE_SEARCH_DEFAULTS = [
  { id: 'youtube', name: 'YouTube', keyword: 'yt', url: 'https://www.youtube.com/results?search_query=%s', suggestUrl: 'https://suggestqueries.google.com/complete/search?client=chrome&ds=yt&ie=UTF-8&oe=UTF-8&q=%s' },
  { id: 'wikipedia', name: 'Wikipedia', keyword: 'wiki', url: 'https://en.wikipedia.org/w/index.php?search=%s', suggestUrl: 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&search=%s' },
];

// @tabs, @bookmarks, @history and @lumio narrow the address bar to one kind of result.
const SCOPES = [
  { keyword: '@tabs', scope: 'tabs', name: 'Tabs', chip: 'Search tabs' },
  { keyword: '@bookmarks', scope: 'bookmarks', name: 'Bookmarks', chip: 'Search bookmarks' },
  { keyword: '@history', scope: 'history', name: 'History', chip: 'Search history' },
  { keyword: '@lumio', scope: 'lumio', name: 'Lumio AI', chip: 'Ask Lumio' },
];

const FOUND_MAX = 50;

function builtins() {
  return Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name, url: e.url, ...BUILTIN_EXTRA[id], builtin: true }));
}

// Added engines and site search (the defaults until the list is first changed).
function custom(settings = {}) {
  return Array.isArray(settings.searchEngines) ? settings.searchEngines.filter(validShape) : SITE_SEARCH_DEFAULTS.map((e) => ({ ...e }));
}

function found(settings = {}) {
  return Array.isArray(settings.searchEnginesFound) ? settings.searchEnginesFound.filter(validShape) : [];
}

const validShape = (e) => e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.keyword === 'string' && typeof e.url === 'string';

// Every usable engine: built-in first, then added ones.
function all(settings = {}) { return [...builtins(), ...custom(settings)]; }

function byId(settings, id) { return all(settings).find((e) => e.id === id) || null; }

// The address bar's default engine (Google if the saved one is gone).
function defaultEngine(settings = {}) {
  return byId(settings, settings.searchEngine) || builtins().find((e) => e.id === 'google');
}

// The engine whose shortcut is `keyword` (case doesn't matter), or a @scope.
function forKeyword(settings, keyword) {
  const k = String(keyword || '').toLowerCase();
  if (!k) return null;
  return SCOPES.find((s) => s.keyword === k) || all(settings).find((e) => e.keyword.toLowerCase() === k) || null;
}

// The shortcuts the address bar turns into a chip, for the shell. A
// built-in engine's shortcut is its domain, so typing "bing.com " still
// searches normally: only Tab makes those a chip.
function keywords(settings = {}) {
  return [
    ...SCOPES.map(({ keyword, scope, chip }) => ({ keyword, scope, chip })),
    ...all(settings).map((e) => ({ keyword: e.keyword, id: e.id, chip: `Search ${e.name}`, ...(e.builtin ? { tabOnly: true } : {}) })),
  ];
}

function searchUrl(engine, text) {
  return engine.url.replace('%s', encodeURIComponent(String(text || '').trim()));
}

// ---------------------------------------------------------------- editing
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }

// A saved URL: http(s), with %s where the search goes.
function checkUrl(url, what = 'URL') {
  let u;
  try { u = new URL(url); } catch { return `Enter a full ${what}, starting with https://`; }
  if (!/^https?:$/.test(u.protocol)) return `The ${what} must start with https:// or http://`;
  if (!url.includes('%s')) return `Put %s in the ${what} where the search words go`;
  if (url.length > 2048) return `That ${what} is too long`;
  return null;
}

// Adds or updates (when entry.id matches one) an added engine. Returns
// { ok, settings: { searchEngines }, engine } or { ok: false, error }.
function save(settings, entry = {}) {
  const name = String(entry.name || '').trim().replace(/\s+/g, ' ');
  const keyword = String(entry.keyword || '').trim();
  const url = String(entry.url || '').trim();
  if (!name) return { ok: false, error: 'Give it a name' };
  if (name.length > 60) return { ok: false, error: 'Use a shorter name' };
  if (!keyword) return { ok: false, error: 'Give it a shortcut, like “yt”' };
  if (/\s/.test(keyword) || keyword.length > 40) return { ok: false, error: 'A shortcut is one short word, with no spaces' };
  if (keyword.startsWith('@')) return { ok: false, error: 'Shortcuts starting with @ are for Lumio’s own (@tabs, @history…)' };
  const bad = checkUrl(url);
  if (bad) return { ok: false, error: bad };
  const list = custom(settings);
  const id = entry.id && list.some((e) => e.id === entry.id) ? entry.id : null;
  const taken = all(settings).find((e) => e.id !== id && e.keyword.toLowerCase() === keyword.toLowerCase());
  if (taken) return { ok: false, error: `“${keyword}” is already the shortcut for ${taken.name}` };
  // The suggestion URL only stays if the search URL is still on the same site.
  const prev = list.find((e) => e.id === id);
  const keepSuggest = prev?.suggestUrl && hostOf(prev.url) === hostOf(url) ? { suggestUrl: prev.suggestUrl } : {};
  const engine = { id: id || `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, keyword, url, ...keepSuggest };
  const next = id ? list.map((e) => (e.id === id ? engine : e)) : [...list, engine];
  return { ok: true, engine, settings: { searchEngines: next } };
}

// Deletes an added engine (or a found one). The default falls back to Google.
function remove(settings, id) {
  const patch = {};
  const list = custom(settings);
  if (list.some((e) => e.id === id)) patch.searchEngines = list.filter((e) => e.id !== id);
  const f = found(settings);
  if (f.some((e) => e.id === id)) patch.searchEnginesFound = f.filter((e) => e.id !== id);
  if (settings.searchEngine === id) patch.searchEngine = 'google';
  return patch;
}

// Turns on an engine found on a website: it moves to the added ones.
function activate(settings, id) {
  const f = found(settings).find((e) => e.id === id);
  if (!f) return null;
  const res = save(settings, { name: f.name, keyword: f.keyword, url: f.url });
  if (!res.ok) return null;
  const engine = f.suggestUrl ? { ...res.engine, suggestUrl: f.suggestUrl } : res.engine;
  return {
    searchEngines: res.settings.searchEngines.map((e) => (e.id === res.engine.id ? engine : e)),
    searchEnginesFound: found(settings).filter((e) => e.id !== id),
  };
}

function setDefault(settings, id) {
  return byId(settings, id) ? { searchEngine: id } : null;
}

// ---------------------------------------------------------------- OpenSearch
// The site a host belongs to, near enough: example.co.uk, youtube.com.
function siteOf(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = parts.at(-1).length === 2 && /^(co|com|net|org|gov|edu|ac|ne|or|go)$/.test(parts.at(-2)) ? 3 : 2;
  return parts.slice(-n).join('.');
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return XML_ENTITIES[e.toLowerCase()] ?? m;
});

function attrs(tag) {
  const out = {};
  for (const [, k, , v1, v2] of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[k.toLowerCase()] = unescapeXml(v1 ?? v2);
  return out;
}

// An OpenSearch template -> a URL with %s, or null if it needs more than the
// search words (optional {params?} are dropped).
function template(t) {
  if (!t || !t.includes('{searchTerms}')) return null;
  const url = t.replace('{searchTerms}', '%s')
    .replace(/\{(inputEncoding|outputEncoding)\??\}/g, 'UTF-8')
    .replace(/\{language\??\}/g, '*')
    .replace(/\{[^}]+\?\}/g, '');
  return /\{[^}]*\}/.test(url) ? null : url;
}

// A description file (XML) from a page -> { name, keyword, url, suggestUrl? }
// or null. Only kept if the search is on the same site as the page, over https.
function parseOpenSearch(xml, pageUrl) {
  const text = String(xml || '');
  if (text.length > 65536 || !/<OpenSearchDescription\b/i.test(text)) return null;
  const pageHost = hostOf(pageUrl);
  if (!pageHost) return null;
  const name = unescapeXml((/<ShortName>([^<]*)<\/ShortName>/i.exec(text)?.[1] || '').trim()).replace(/\s+/g, ' ').slice(0, 60);
  let url = null;
  let suggestUrl = null;
  for (const [tag] of text.matchAll(/<Url\b[^>]*>/gi)) {
    const a = attrs(tag);
    const type = (a.type || '').toLowerCase();
    const t = template(a.template);
    if (!t) continue;
    const ok = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && siteOf(x.hostname) === siteOf(pageHost); } catch { return false; } };
    if (type === 'text/html' && !url && ok(t)) url = t;
    if (type === 'application/x-suggestions+json' && !suggestUrl && ok(t)) suggestUrl = t;
  }
  if (!url || checkUrl(url)) return null;
  const keyword = pageHost.replace(/^www\./, '');
  return { name: name || keyword, keyword, url, ...(suggestUrl ? { suggestUrl } : {}) };
}

// Remembers an engine found on a site (inactive), unless that site already
// has one or it was already found. Returns the settings patch, or null.
function addFound(settings, f) {
  if (!f) return null;
  const host = hostOf(f.url);
  const known = [...all(settings), ...found(settings)];
  if (known.some((e) => e.keyword.toLowerCase() === f.keyword.toLowerCase() || hostOf(e.url) === host)) return null;
  const entry = { id: `found-${f.keyword.replace(/[^a-z0-9.-]/gi, '')}`, name: f.name, keyword: f.keyword, url: f.url, ...(f.suggestUrl ? { suggestUrl: f.suggestUrl } : {}), found: Date.now() };
  return { searchEnginesFound: [entry, ...found(settings)].slice(0, FOUND_MAX) };
}

module.exports = {
  SCOPES, SITE_SEARCH_DEFAULTS, builtins, custom, found, all, byId, defaultEngine, forKeyword, keywords, searchUrl,
  save, remove, activate, setDefault, parseOpenSearch, addFound, siteOf,
};
