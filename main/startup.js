// What opens when Lumio starts (Settings › On startup) and where the Home
// button goes (Settings › Appearance), like Chrome. Pure functions over the
// settings object, no Electron (tests/startup.test.mjs).
const { parseInput } = require('./omnibox');

const NEWTAB = 'lumio://newtab/';
const STARTUP = ['newtab', 'restore', 'pages'];
const MAX_PAGES = 50;

// A web address someone typed for a start page or the home page: "example.com"
// becomes https://example.com/. Searches and other kinds of addresses don't count.
function cleanUrl(input) {
  const parsed = parseInput(String(input || '').slice(0, 2048));
  if (!parsed || parsed.isSearch || !/^(https?|file):/i.test(parsed.url)) return null;
  return parsed.url;
}

// The start pages list, tidied: valid addresses only, no repeats, titles kept short.
function cleanPages(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const url = cleanUrl(typeof item === 'string' ? item : item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 200) : '';
    out.push({ url, title });
    if (out.length >= MAX_PAGES) break;
  }
  return out;
}

const startupMode = (settings = {}) => (STARTUP.includes(settings.startup) ? settings.startup : 'restore');

// What the first launch of a session opens: the last session's windows
// (sessionWindows is only read when it's needed), or the start pages, or a new tab.
function startupPlan(settings = {}, sessionWindows = () => []) {
  const mode = startupMode(settings);
  if (mode === 'restore') return { windows: sessionWindows(), urls: [] };
  if (mode === 'pages') return { windows: [], urls: cleanPages(settings.startupPages).map((p) => p.url) };
  return { windows: [], urls: [] };
}

// Where the Home button goes: the New Tab page unless a web address was chosen.
function homeUrl(settings = {}) {
  return (settings.homePage && settings.homePage !== 'newtab' && cleanUrl(settings.homePage)) || NEWTAB;
}

module.exports = { STARTUP, MAX_PAGES, cleanUrl, cleanPages, startupMode, startupPlan, homeUrl };
