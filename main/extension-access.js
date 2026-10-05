// What an extension may do, in plain words, and how Lumio limits where it
// runs. No Electron imports (unit-tested in tests/extension-access.test.mjs).
//
// Site access ("This can read and change site data"):
//   'all'   - what the extension asked for when it was added (the default)
//   'sites' - only on the sites the person lists
//   'click' - its button still works, but its page scripts and site
//             permissions are taken away (Electron has no activeTab, so a
//             click doesn't grant the page the way Chrome's does)
// Electron has no switch for this, so Lumio loads a limited copy of the
// extension: the same files (hard links, no extra disk space) with a
// manifest.json whose content_scripts and host permissions only cover the
// allowed sites. The copy keeps the manifest's "key", so the extension keeps
// its ID and its saved data. Unpacked extensions without a key can't be
// limited this way (their ID comes from their folder).
const fs = require('fs');
const path = require('path');

// Folders of limited copies sit next to the version folder they're made from
// (Extensions/<id>/<version>_0~lumio), so the Web Store updater still finds
// the extensions folder two levels up.
const RESTRICTED_SUFFIX = '~lumio';
const ACCESS_MODES = ['click', 'sites', 'all'];

// ---------------------------------------------------------------- match patterns
const PATTERN_RE = /^(\*|https?|wss?|ftp|file|urn):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/;
const isHostPattern = (p) => typeof p === 'string' && (p === '<all_urls>' || PATTERN_RE.test(p));

function parsePattern(p) {
  if (p === '<all_urls>') return { scheme: '*', host: '*', path: '/*' };
  const m = PATTERN_RE.exec(p || '');
  return m ? { scheme: m[1], host: m[2], path: m[3] } : null;
}

// A site as people type it: "example.com", "*.example.com", or a pasted
// address. Returns the host part, lowercased, or null.
function normalizeSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z*]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (s === '*') return null; // that's "all sites", a mode of its own
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s) && s !== 'localhost') return null;
  return s;
}

// Does host pattern `general` ("*", "*.a.com", "a.com") include `specific`?
function covers(general, specific) {
  if (general === '*') return true;
  if (specific === '*') return false;
  const gWild = general.startsWith('*.');
  const gBase = gWild ? general.slice(2) : general;
  const sWild = specific.startsWith('*.');
  const sBase = sWild ? specific.slice(2) : specific;
  if (!gWild) return !sWild && sBase === gBase;
  return sBase === gBase || sBase.endsWith('.' + gBase);
}

// The part of two host patterns that both allow, or null.
function intersectHosts(a, b) {
  if (covers(a, b)) return b;
  if (covers(b, a)) return a;
  return null;
}

// Does a host pattern allow this page's host?
const hostAllowed = (pattern, host) => covers(pattern, String(host || '').toLowerCase());

// Narrow one match pattern to the listed sites. file:// access is its own
// switch ("Allow access to file URLs"): with it on, file patterns stay.
function narrowPattern(pattern, sites, { files = false } = {}) {
  const p = parsePattern(pattern);
  if (files && p?.scheme === 'file') return [pattern];
  if (files && pattern === '<all_urls>') return [...narrowPattern(pattern, sites), 'file:///*'];
  if (!p || !['*', 'http', 'https', 'ws', 'wss'].includes(p.scheme)) return [];
  const out = [];
  for (const site of sites) {
    const host = intersectHosts(p.host, site);
    if (host) out.push(`${p.scheme}://${host}${p.path}`);
  }
  return out;
}

const uniq = (list) => [...new Set(list)];

// A copy of the manifest that only reaches the allowed sites.
// access: { mode: 'click' | 'sites', sites: [...], files: allowed on file URLs }
function restrictManifest(manifest, access) {
  const sites = access?.mode === 'sites' ? uniq((access.sites || []).map(normalizeSite).filter(Boolean)) : [];
  const narrow = (patterns) => uniq((patterns || []).flatMap((p) => (isHostPattern(p) ? narrowPattern(p, sites, { files: !!access?.files }) : [p])));
  const out = JSON.parse(JSON.stringify(manifest));
  if (Array.isArray(out.content_scripts)) {
    // An entry without matches won't load, so entries that lose them all go.
    out.content_scripts = out.content_scripts
      .map((cs) => ({ ...cs, matches: narrow(cs.matches) }))
      .filter((cs) => cs.matches.length);
  }
  for (const key of ['host_permissions', 'optional_host_permissions', 'permissions', 'optional_permissions']) {
    if (Array.isArray(out[key])) out[key] = narrow(out[key]);
  }
  return out;
}

// Does the extension ask to run on websites at all? (Otherwise site access
// doesn't apply to it.)
function wantsSites(manifest) {
  const m = manifest || {};
  const patterns = [
    ...(m.content_scripts || []).flatMap((cs) => cs.matches || []),
    ...(m.host_permissions || []),
    ...(m.permissions || []),
  ];
  return patterns.some(isHostPattern);
}

// Can Lumio limit it? Only with a manifest key (Web Store installs have one).
const canRestrict = (manifest) => !!manifest?.key && wantsSites(manifest);

// The extension's site access for one page: 'granted' (it runs there),
// 'withheld' (it would, but the person limited it) or 'none'.
function accessOn(manifest, access, url) {
  let u;
  try { u = new URL(url); } catch { return 'none'; }
  if (!/^https?:$/.test(u.protocol)) return 'none';
  const host = u.hostname.toLowerCase();
  const m = manifest || {};
  const patterns = [...(m.content_scripts || []).flatMap((cs) => cs.matches || []), ...(m.host_permissions || []), ...(m.permissions || [])]
    .map(parsePattern).filter(Boolean);
  if (!patterns.some((p) => hostAllowed(p.host, host))) return 'none';
  const mode = access?.mode || 'all';
  if (mode === 'all') return 'granted';
  if (mode === 'sites' && (access.sites || []).some((s) => hostAllowed(normalizeSite(s) || '', host))) return 'granted';
  return 'withheld';
}

// ---------------------------------------------------------------- permissions, in plain words
const ALL_SITES = 'Read and change all your data on all websites';
const WARNINGS = {
  bookmarks: 'Read and change your bookmarks',
  clipboardRead: 'Read data you copy and paste',
  clipboardWrite: 'Change data you copy and paste',
  contentSettings: 'Change which sites can use cookies, JavaScript, your camera and more',
  debugger: 'Access the page debugger',
  declarativeNetRequest: 'Block content on any page',
  declarativeNetRequestWithHostAccess: 'Block content on the sites it can read',
  desktopCapture: 'Capture what’s on your screen',
  downloads: 'Manage your downloads',
  'downloads.open': 'Open downloaded files',
  geolocation: 'Know your location',
  history: 'Read and change your browsing history',
  'identity.email': 'Know your email address',
  management: 'Manage your extensions',
  nativeMessaging: 'Talk to apps on your computer',
  notifications: 'Show notifications',
  pageCapture: ALL_SITES,
  privacy: 'Change your privacy settings',
  proxy: ALL_SITES,
  tabCapture: 'Record the sound and picture of your tabs',
  tabs: 'Read your browsing history',
  topSites: 'Read a list of the sites you visit most',
  ttsEngine: 'Read all text spoken with synthesized speech',
  webNavigation: 'Read your browsing history',
};

// Chrome-style warnings for what the extension asks for, most important first.
function describePermissions(manifest) {
  const m = manifest || {};
  const perms = [...(m.permissions || []), ...(m.host_permissions || [])].filter((p) => typeof p === 'string');
  const scripts = (m.content_scripts || []).flatMap((cs) => cs.matches || []);
  const patterns = [...perms, ...scripts].filter(isHostPattern).map(parsePattern).filter(Boolean);
  const out = [];
  if (patterns.some((p) => p.host === '*')) out.push(ALL_SITES);
  else {
    const hosts = uniq(patterns.filter((p) => p.scheme !== 'file').map((p) => p.host.replace(/^\*\./, '')));
    if (hosts.length === 1) out.push(`Read and change your data on ${hosts[0]}`);
    else if (hosts.length > 1 && hosts.length <= 3) out.push(`Read and change your data on ${hosts.slice(0, -1).join(', ')} and ${hosts.at(-1)}`);
    else if (hosts.length > 3) out.push(`Read and change your data on ${hosts.length} sites`);
  }
  for (const p of perms) {
    const w = WARNINGS[p];
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

// Parts of the extension that may not work in Lumio (Electron doesn't have
// them, or Lumio only covers part of them). Shown on its details page.
const LIMITS = {
  // electron-chrome-extensions finds the apps installed for Chrome, but some
  // (desktop password managers) only answer Chrome itself.
  nativeMessaging: 'May not be able to talk to apps on your computer (some only work with Chrome).',
  declarativeNetRequest: 'Blocking content with rule lists may not work.',
  declarativeNetRequestWithHostAccess: 'Blocking content with rule lists may not work.',
  sidePanel: 'Opens its side panel in a tab.',
  identity: 'Signs in through a pop-up window.',
  tabGroups: 'Can’t see or change tab groups.',
  debugger: 'Can’t use the page debugger.',
  downloads: 'Can’t manage downloads.',
  history: 'Can’t read your history.',
  bookmarks: 'Can’t read your bookmarks.',
  topSites: 'Can’t read your most visited sites.',
  tts: 'Can’t speak text aloud.',
  ttsEngine: 'Can’t provide voices.',
  tabCapture: 'Can’t record tabs.',
  desktopCapture: 'Can’t capture your screen.',
  privacy: 'Can’t change privacy settings.',
  proxy: 'Can’t set a proxy.',
  readingList: 'Can’t use the reading list.',
  sessions: 'Can’t see recently closed tabs.',
  gcm: 'Can’t receive push messages.',
};
function limitations(manifest) {
  const perms = [...(manifest?.permissions || []), ...(manifest?.optional_permissions || [])].filter((p) => typeof p === 'string');
  const out = uniq(perms.map((p) => LIMITS[p]).filter(Boolean));
  if (manifest?.manifest_version === 2) out.unshift('Uses an older extension format (Manifest V2) that Chrome no longer supports.');
  return out;
}

// ---------------------------------------------------------------- the limited copy on disk
// Rebuilds `dest` from `src` with the restricted manifest. Files are hard
// links (copies if the disk can't link). A small marker records what it was
// made from, so an unchanged copy is reused at the next launch.
function buildRestrictedCopy(src, dest, access) {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const marker = JSON.stringify({ src, access: { mode: access.mode, sites: access.sites || [], files: !!access.files }, version: manifest.version });
  try {
    if (fs.readFileSync(path.join(dest, '.lumio-access.json'), 'utf8') === marker) return dest;
  } catch { /* build it */ }
  fs.rmSync(dest, { recursive: true, force: true });
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) walk(a, b);
      else if (entry.isFile() && !(from === src && entry.name === 'manifest.json')) {
        try { fs.linkSync(a, b); } catch { fs.copyFileSync(a, b); }
      }
    }
  };
  walk(src, dest);
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(restrictManifest(manifest, access), null, 2));
  fs.writeFileSync(path.join(dest, '.lumio-access.json'), marker);
  return dest;
}

// Total size of a folder's files, in bytes.
async function folderSize(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

module.exports = {
  RESTRICTED_SUFFIX, ACCESS_MODES,
  isHostPattern, parsePattern, normalizeSite, covers, intersectHosts, narrowPattern, restrictManifest,
  wantsSites, canRestrict, accessOn, describePermissions, limitations, buildRestrictedCopy, folderSize,
};
