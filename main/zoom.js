// Page zoom, like Chrome: the same preset steps (Cmd+Plus/Minus, Ctrl+wheel),
// a default for every site (Settings › Appearance › Page zoom) and a level
// per site that comes back after a restart (Settings › Zoom levels).
// Chromium already shares a zoom level between the tabs of one site, but only
// until Lumio quits, so the levels people choose are kept in settings here.
// Pure functions over the settings object, no Electron (tests/zoom.test.mjs).

// Chrome's zoom steps, in percent.
const PRESETS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const MAX_SITES = 500; // a site list nobody scrolls through is a bug, not a feature

// 33% and 67% are really a third and two thirds.
const factorOf = (percent) => (percent === 33 ? 1 / 3 : percent === 67 ? 2 / 3 : percent / 100);
const percentOf = (factor) => Math.round(factor * 100);

function defaultZoom(settings = {}) {
  return PRESETS.includes(settings.defaultZoom) ? settings.defaultZoom : 100;
}

// The next step up (1) or down (-1) from where the page is; 0 goes back to the default.
function stepZoom(current, step, def = 100) {
  if (step === 0) return def;
  if (step > 0) return PRESETS.find((p) => p > current + 0.5) ?? PRESETS[PRESETS.length - 1];
  return [...PRESETS].reverse().find((p) => p < current - 0.5) ?? PRESETS[0];
}

// The site a zoom level belongs to: the host name of a web page (www.example.com
// and example.com are different sites, as in Chrome). Other pages aren't kept.
function siteKey(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && u.hostname ? u.hostname.toLowerCase() : null;
  } catch { return null; }
}

// What Chromium shares a zoom level by within one session: the host for most
// pages, the whole address for files.
function zoomKey(url) {
  try {
    const u = new URL(url);
    return u.hostname ? `${u.protocol}//${u.hostname.toLowerCase()}` : u.href.replace(/#.*$/, '');
  } catch { return ''; }
}

function zoomFor(settings, url) {
  const key = siteKey(url);
  const level = key ? settings.zoomLevels?.[key] : undefined;
  return PRESETS.includes(level) ? level : defaultZoom(settings);
}

// The level someone picked for a page's site. The default needs no entry.
// Returns whether anything changed.
function rememberZoom(store, url, percent) {
  const key = siteKey(url);
  if (!key || !PRESETS.includes(percent)) return false;
  const levels = { ...(store.settings.zoomLevels || {}) };
  if (percent === defaultZoom(store.settings)) {
    if (!(key in levels)) return false;
    delete levels[key];
  } else {
    if (levels[key] === percent) return false;
    delete levels[key]; // newest last, so the oldest go first past MAX_SITES
    levels[key] = percent;
    const keys = Object.keys(levels);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SITES))) delete levels[old];
  }
  store.setSetting('zoomLevels', levels);
  return true;
}

function forgetZoom(store, host) {
  const levels = { ...(store.settings.zoomLevels || {}) };
  if (!(host in levels)) return false;
  delete levels[host];
  store.setSetting('zoomLevels', levels);
  return true;
}

// Settings › Zoom levels: every site with its own level, A to Z.
function zoomList(settings = {}) {
  return Object.entries(settings.zoomLevels || {})
    .filter(([, percent]) => PRESETS.includes(percent))
    .map(([host, percent]) => ({ host, percent }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

module.exports = { PRESETS, factorOf, percentOf, defaultZoom, stepZoom, siteKey, zoomKey, zoomFor, rememberZoom, forgetZoom, zoomList };
