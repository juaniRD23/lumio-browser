// Opt-in crash reports: "Send crash reports to Lumio" in Settings › Privacy
// (also offered once on the welcome screens), off by default, like Chrome's
// "Help improve Chrome". When it's on at launch:
//   - Crashpad (Electron's crashReporter) uploads a minidump to the Lumio
//     server (POST /api/crash, server/src/crashes.ts) when a Lumio process crashes;
//   - JavaScript errors in the main process, and pages or helper processes
//     that died, go there as a small JSON report.
// Both carry Lumio's version, platform, arch and channel, and nothing else
// about the person: never web addresses, page titles, the account or anything
// from pages. Stack traces keep Lumio's own file paths (main/tabs.js:183:7)
// and drop every other path and address.
// Crashpad can only start before the app is ready, so the setting is read
// straight from settings.json, and turning it on takes effect on the next
// launch. Turning it off stops uploads right away.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAX_PER_LAUNCH = 10; // JSON reports: an error that repeats shouldn't flood the server
const NOT_CRASHES = new Set(['clean-exit', 'memory-eviction']); // normal ways for a process to end

// 'beta' for Lumio Beta, 'dev' when running from source, else 'stable'.
const channelOf = ({ beta, packaged }) => (beta ? 'beta' : packaged ? 'stable' : 'dev');

// The setting, read before the app is ready (main/store.js isn't loaded yet).
function readSetting(userData) {
  try { return JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).crashReports === true; } catch { return false; }
}

// Web addresses, emails and file paths could say who someone is or what they
// were browsing.
function scrub(text, max) {
  const s = String(text ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"()<>]*/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/(?<![\w.~-])(?:[A-Za-z]:|~)?(?:[\\/][^\\/'"():<>\r\n]+){2,}/g, '<path>');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
// Messages can also name a site without its scheme ("getaddrinfo ENOTFOUND
// mybank.example.com"), an IP address or a token. Anything shaped like a host
// goes, even when it's really code ("tab.view is not a function"): the stack
// still says where the bug is. Lumio's own file names (tabs.js) stay.
const CODE_FILES = /^(?:c?js|mjs|ts|json|node|html|css|map|asar|wasm|pak|plist|dylib|so|dll|exe|app|framework)$/i;
function scrubHosts(text) {
  return String(text)
    .replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){0,6}::[0-9a-f:]*[0-9a-f](?![\w:])/gi, '<ip>')
    .replace(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g, '<ip>')
    .replace(/(?<![\w$@.\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]*[a-z0-9])\.?(?![\w$-]|\.\w)/gi, (m, last) => (CODE_FILES.test(last) && !/\..*\./.test(m) ? m : '<host>'))
    .replace(/(?<![\w+\/=-])(?=[\w+\/=-]*\d)(?=[\w+\/=-]*[A-Za-z])[\w+\/=-]{24,}/g, '<token>');
}
// Quoted text in a message could be anything from a page, so only property
// names in V8's "(reading 'x')" stay.
function cleanMessage(text) {
  const keep = [];
  const marked = String(text ?? '').replace(/\((reading|setting) '([\w$]{1,40})'\)/g, (_m, verb, prop) => `(${verb} \u0000${keep.push(prop) - 1}\u0000)`);
  const out = scrub(scrubHosts(scrub(marked.replace(/(['"`])(?:(?!\1)[^\r\n])*\1/g, '…'), Infinity)), 300);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `'${keep[i]}'`);
}

// "at fn (/Applications/Lumio Browser.app/…/app.asar/main/tabs.js:183:7)"
// → "at fn (main/tabs.js:183:7)". Code outside Lumio becomes "elsewhere".
function cleanLocation(loc, root) {
  let p = loc.replace(/^file:\/\/\/?(?=[A-Za-z]:)/i, '').replace(/^file:\/\//i, '');
  try { p = decodeURI(p); } catch { /* keep it as it is */ }
  p = p.replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  const win = /^[A-Za-z]:\//.test(base);
  if (win ? p.toLowerCase().startsWith(base.toLowerCase()) : p.startsWith(base)) return p.slice(base.length);
  if (/^node:[\w/.-]+(?::\d+:\d+)?$/.test(p) || /^(native|<anonymous>|index \d+)$/.test(p)) return p;
  const at = /:\d+:\d+$/.exec(p);
  return 'elsewhere' + (at ? at[0] : '');
}
function cleanStack(stack, root = ROOT, max = 12) {
  const frames = [];
  for (const line of String(stack ?? '').split('\n')) {
    const m = /^\s*at (?:(.*?) \()?(.*?)\)?\s*$/.exec(line);
    if (!m) continue;
    const fn = m[1] && /^[\w$.<>\[\] -]{1,80}$/.test(m[1]) ? m[1] : m[1] ? '<fn>' : '';
    const where = cleanLocation(m[2], root);
    frames.push(`    at ${fn ? `${fn} (${where})` : where}`);
    if (frames.length >= max) break;
  }
  return frames.join('\n');
}

// A JavaScript error in the main process (or whatever a promise was rejected with).
function errorReport(err, reason, meta, root = ROOT) {
  const isError = err instanceof Error || (err && typeof err === 'object' && typeof err.stack === 'string');
  const name = isError && /^[\w$.]{1,40}$/.test(String(err.name)) ? String(err.name) : isError ? 'Error' : 'NonError';
  const kind = err === null ? 'null' : typeof err;
  const message = isError ? cleanMessage(err.message) : typeof err === 'string' ? cleanMessage(err) : `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} value`;
  const frames = isError ? cleanStack(err.stack, root) : '';
  return { ...meta, type: 'js', process: 'browser', reason, name, message, stack: `${name}: ${message}${frames ? '\n' + frames : ''}` };
}

// Which kind of page lived in a renderer that died (never its address).
function whereOf(url) {
  if (/^lumio:/i.test(url)) return 'ui';
  if (/^chrome-extension:/i.test(url)) return 'extension';
  return 'page';
}
// Electron's child process types, named like Crashpad names them.
const childType = (type) => (type === 'GPU' ? 'gpu-process' : String(type || 'unknown').toLowerCase().replace(/[^a-z]+/g, '-'));

function createCrashReports({ app, crashReporter, fetchImpl = globalThis.fetch, base, beta = false, root = ROOT, platform = process.platform, arch = process.arch, proc = process }) {
  let active = false; // Crashpad started at this launch
  let on = false; // the setting right now
  let quitting = false;
  let sent = 0;
  const seen = new Set();
  const submitURL = `${base.replace(/\/$/, '')}/api/crash`;
  const meta = () => ({ version: app.getVersion(), platform, arch, channel: channelOf({ beta, packaged: app.isPackaged }) });

  async function send(report) {
    if (!active || !on || sent >= MAX_PER_LAUNCH) return false;
    // The same error once per launch.
    const key = `${report.type}|${report.process}|${report.reason}|${report.name || ''}|${report.where || ''}|${(report.stack || '').split('\n')[1] || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    sent++;
    try {
      await fetchImpl(submitURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(10_000) });
      return true;
    } catch { return false; } // offline: crash reports are best effort
  }

  function start() {
    on = readSetting(app.getPath('userData'));
    if (!on) return false;
    try {
      crashReporter.start({
        submitURL,
        productName: 'Lumio Browser',
        uploadToServer: true,
        // Only these, on every process's reports. Never anything about pages or the person.
        globalExtra: { _companyName: 'Lumio', ...meta() },
      });
    } catch (err) {
      console.error('[lumio] crash reports could not start:', err?.message || err); // never worth stopping the browser for
      return false;
    }
    active = true;
    // Reporting a problem must never cause one of its own.
    const quietly = (fn) => (...args) => { try { fn(...args); } catch { /* best effort */ } };
    proc.on('uncaughtException', quietly((err) => send(errorReport(err, 'uncaughtException', meta(), root))));
    proc.on('unhandledRejection', quietly((err) => send(errorReport(err, 'unhandledRejection', meta(), root))));
    app.on('render-process-gone', quietly((_e, wc, details) => {
      if (quitting || NOT_CRASHES.has(details?.reason)) return;
      let url = '';
      try { url = wc.getURL(); } catch { /* already gone */ }
      send({ ...meta(), type: 'gone', process: 'renderer', where: whereOf(url), reason: details.reason, exitCode: details.exitCode });
    }));
    app.on('child-process-gone', quietly((_e, details) => {
      if (quitting || NOT_CRASHES.has(details?.reason)) return;
      send({ ...meta(), type: 'gone', process: childType(details.type), ...(details.name ? { name: details.name } : {}), reason: details.reason, exitCode: details.exitCode });
    }));
    app.on('before-quit', () => { quitting = true; });
    return true;
  }

  return {
    start,
    send,
    // { on: the setting, active: running since this launch }
    state: () => ({ on, active }),
    setEnabled(store, value) {
      on = value === true;
      store.setSetting('crashReports', on);
      if (active) crashReporter.setUploadToServer(on);
      return { on, active };
    },
  };
}

// main.js: started before the app is ready.
function setup(app) {
  const { crashReporter } = require('electron');
  const { LUMIO_BASE } = require('./account');
  const reports = createCrashReports({ app, crashReporter, base: LUMIO_BASE, beta: require('./flavor').beta });
  reports.start();
  return reports;
}

module.exports = { setup, createCrashReports, readSetting, cleanMessage, cleanStack, errorReport, channelOf };
