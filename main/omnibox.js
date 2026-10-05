// Omnibox logic: decide between URL and search, and build suggestions.
// Pure functions, no Electron imports (unit-tested in tests/omnibox.test.mjs).

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
  // chrome://history, chrome://extensions etc. open Lumio's own pages.
  const page = /^(?:chrome|about):\/*(history|downloads|bookmarks|extensions|settings|passwords|newtab)\/?(.*)$/i.exec(text);
  if (page) return { url: `lumio://${page[1].toLowerCase()}/${page[2]}`, isSearch: false };
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

function suggest(raw, { history = [], bookmarks = [], searchTemplate, limit = 6 } = {}) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const parsed = parseInput(text, searchTemplate);
  const out = [];
  if (parsed.isSearch) out.push({ type: 'search', title: text, url: parsed.url });
  else out.push({ type: 'url', title: displayUrl(parsed.url), url: parsed.url });

  const q = text.toLowerCase();
  const scored = new Map();
  const now = Date.now();
  const consider = (item, bonus) => {
    const url = item.url.toLowerCase();
    const title = (item.title || '').toLowerCase();
    const bare = displayUrl(url);
    let score = 0;
    if (bare.startsWith(q)) score += 12;
    else if (url.includes(q)) score += 5;
    if (title.includes(q)) score += title.startsWith(q) ? 7 : 4;
    if (!score) return;
    const age = (now - (item.time || 0)) / 86_400_000;
    score += bonus + Math.max(0, 3 - age / 3);
    const prev = scored.get(item.url);
    // The site's icon, from whichever bookmark or visit has one.
    if (prev) { prev.score += 1.5; prev.favicon ||= item.favicon; }
    else scored.set(item.url, { item, score, favicon: item.favicon });
  };
  for (const b of bookmarks) consider(b, 6);
  for (let i = history.length - 1; i >= 0 && i >= history.length - 3000; i--) consider(history[i], 0);

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  for (const { item, favicon } of ranked) {
    if (out.length >= limit) break;
    if (out.some((o) => o.url === item.url)) continue;
    out.push({ type: bookmarks.some((b) => b.url === item.url) ? 'bookmark' : 'history', title: item.title || displayUrl(item.url), url: item.url, ...(favicon ? { favicon } : {}) });
  }
  if (parsed.isSearch) out.push({ type: 'ai', title: text });
  return out;
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

module.exports = { parseInput, suggest, topSites, displayUrl };
