// Links that open another app (mailto:, tel:, zoommtg:, slack:, spotify:…),
// with Chrome's rules:
//  - Some schemes are never handed to another app: they run code, open files
//    or reach into Windows (file:, javascript:, search-ms:, ms-msdt:…).
//  - mailto: opens the mail app without asking, like Chrome. Anything else
//    asks "Open <App>?" in the tab, and the person can always allow that site
//    to open that kind of link.
//  - A page can't keep launching apps: after one launch or prompt, the next
//    needs the person to click or type in the page first. A frame from
//    another site needs that click before its first one too.
// Pure functions; main.js shows the prompt and opens the app.

// Handled inside the browser, never by another app.
const WEB = new Set(['http', 'https', 'about', 'blob', 'data', 'file', 'filesystem', 'javascript', 'lumio', 'chrome', 'chrome-extension', 'devtools', 'view-source', 'ws', 'wss']);
// Never opened: Chrome's list, plus Windows schemes that run programs or
// search the disk (search-ms: and ms-msdt: were used to attack Windows).
const BLOCKED = new Set([
  'afp', 'data', 'disk', 'disks', 'file', 'hcp', 'ie.http', 'javascript', 'ms-help', 'nntp', 'res', 'shell', 'vbscript', 'view-source', 'vnd.ms.radio',
  'search', 'search-ms', 'its', 'mk', 'ms-its', 'mhtml', 'jar',
]);
// The ms- schemes Office documents use ("Open in Desktop App"). Every other
// ms- scheme reaches into Windows itself and is blocked.
const OFFICE = /^ms-(word|excel|powerpoint|visio|access|project|publisher|spd|infopath)$/;
// Open without asking (Chrome's list, minus the long-gone news: ones).
const ALWAYS = new Set(['mailto']);

const schemeOf = (url) => (/^([a-z][a-z0-9+.-]*):/i.exec(String(url || ''))?.[1] || '').toLowerCase();

// 'web' (the browser loads it), 'external' (another app may open it),
// 'blocked' (never opened) or 'invalid'.
function classify(url) {
  const scheme = schemeOf(url);
  if (!scheme) return 'invalid';
  if (scheme.length === 1) return 'blocked'; // C:/Windows/… would run a program
  if (WEB.has(scheme)) return BLOCKED.has(scheme) ? 'blocked' : 'web';
  if (BLOCKED.has(scheme) || (scheme.startsWith('ms-') && !OFFICE.test(scheme))) return 'blocked';
  return 'external';
}

// What goes to the other app: spaces, quotes and the like escaped, as Chrome
// does, so the URL can't break out into extra arguments.
function escapeUrl(url) {
  try {
    return String(url).replace(/[\u0000-\u0020"<>\\^`{|}\u007f]|[^\u0000-\u007f]/gu, (c) => encodeURIComponent(c));
  } catch { return null; } // a lone surrogate
}

// "zoom.us" from "zoom.us.app", "Slack" from "Slack.exe" (or slack.desktop on Linux).
const appLabel = (name) => String(name || '').trim().replace(/\.(app|exe|desktop)$/i, '');

// The site asking: its origin, or null for one that has none (a sandboxed
// frame, a data: page), which can't be remembered.
function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}

// What happens to a request: 'launch', 'ask' or 'deny'.
//  typed: the person typed or picked it in Lumio (address bar, bookmark).
//  origin / topOrigin: the frame asking, and the page it's in.
//  activated: the person clicked or typed in the page just now.
//  locked: the page already launched or asked since the last click.
//  remembered: the person always allows this site this kind of link.
function decide({ url, typed = false, origin = null, topOrigin = null, isMainFrame = true, activated = false, locked = false, remembered = false }) {
  if (classify(url) !== 'external') return 'deny';
  const always = ALWAYS.has(schemeOf(url));
  if (typed) return always ? 'launch' : 'ask';
  if (locked) return 'deny';
  // A frame from another site (an ad), or a page without a site, only after a click.
  if (!activated && (!origin || (!isMainFrame && origin !== topOrigin))) return 'deny';
  return always || remembered ? 'launch' : 'ask';
}

// The prompt in the tab. Cancel is the main button: Enter never opens an app.
function askSpec({ app, origin, incognito = false }) {
  const host = origin ? new URL(origin).host : null;
  return {
    kind: 'external',
    title: `Open ${app}?`,
    message: origin ? `${origin} wants to open this application.` : 'A website wants to open this application.',
    ...(host && !incognito ? { checkbox: { label: `Always allow ${host} to open links of this type in the associated app` } } : {}),
    buttons: [{ id: 'open', label: `Open ${app}` }, { id: 'cancel', label: 'Cancel', primary: true }],
    cancel: 'cancel',
  };
}

// Where "always allow" is kept: the site's permissions, one per scheme.
const permissionKey = (url) => `openExternal:${schemeOf(url)}`;

module.exports = { classify, decide, askSpec, escapeUrl, appLabel, originOf, permissionKey, schemeOf };
