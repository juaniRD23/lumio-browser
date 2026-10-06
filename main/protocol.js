// lumio:// serves the browser's own UI and internal pages from disk.
//   lumio://shell/, overlay/, aura/, dialog/, popup/, notice/, picker/, taskmanager/, print/ -> renderer/ui (default session only)
//   lumio://newtab/, settings, history, downloads, bookmarks, extensions,
//   error, welcome, credits, interstitial (warning pages), apps, version, flags-lite -> renderer/pages (tab sessions)
//   a page's sub-pages (lumio://extensions/shortcuts, lumio://settings/content) -> that page's HTML
//   lumio://settings/shortcuts                         -> renderer/pages/shortcuts.html
//   */assets/*  -> renderer/assets,  */vendor/* -> whitelisted node_modules files
//   shell/ai-files/* -> pictures Lumio made (userData/ai-files)
//   shell/web/*      -> Lumio Chat's file code (docmaker, attach) and its libraries, copied at build
//   credits/chromium.html -> Chromium's license notices, as Electron ships them
const fs = require('fs');
const path = require('path');
const { electronFile, chromiumCreditsHtml } = require('./credits');
const { localizeHtml } = require('./i18n');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'renderer', 'ui');
const PAGES_DIR = path.join(ROOT, 'renderer', 'pages');
const ASSETS_DIR = path.join(ROOT, 'renderer', 'assets');
const VENDOR = {
  'marked.js': path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js'),
  'purify.js': path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs'),
};

const UI_HOSTS = new Set(['shell', 'overlay', 'aura', 'dialog', 'popup', 'notice', 'picker', 'taskmanager', 'print']);
const PAGE_HOSTS = new Set(['newtab', 'settings', 'history', 'downloads', 'bookmarks', 'extensions', 'passwords', 'error', 'welcome', 'credits', 'interstitial', 'apps', 'version', 'flags-lite']);
const CHROMIUM_CREDITS = 'LICENSES.chromium.html';
// Settings' sub-pages are pages of their own under the same host, like
// chrome://settings/content/… and chrome://settings/clearBrowserData.
const SETTINGS_PAGES = { content: 'site-settings.html', cookies: 'site-settings.html', clearBrowserData: 'clear-data.html', security: 'security.html', trackingProtection: 'security.html' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob: crx:",
  "font-src 'self'",
  "media-src 'self' blob:", // Lumio's voice plays from blob: URLs (renderer/ui/voice.js)
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

function inside(dir, file) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveFile(url, hosts) {
  const host = url.hostname;
  if (!hosts.has(host)) return null;
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/assets/')) {
    const f = path.join(ASSETS_DIR, pathname.slice(8));
    return inside(ASSETS_DIR, f) ? f : null;
  }
  if (pathname.startsWith('/vendor/')) return VENDOR[pathname.slice(8)] || null;
  if (host === 'credits' && pathname === '/chromium.html') return electronFile(CHROMIUM_CREDITS);
  // Pictures Lumio made in a chat (the panel only).
  if (pathname.startsWith('/ai-files/') && UI_HOSTS.has(host)) {
    const dir = path.join(require('electron').app.getPath('userData'), 'ai-files');
    const f = path.join(dir, pathname.slice(10));
    return inside(dir, f) ? f : null;
  }
  const base = UI_HOSTS.has(host) ? UI_DIR : PAGES_DIR;
  if (pathname === '/' || pathname === '') return path.join(base, host + '.html');
  if (host === 'settings' && pathname === '/shortcuts') return path.join(PAGES_DIR, 'shortcuts.html'); // Settings › Keyboard shortcuts
  const sub = host === 'settings' && !path.extname(pathname) && SETTINGS_PAGES[pathname.split('/')[1]];
  if (sub) return path.join(PAGES_DIR, sub);
  if (!UI_HOSTS.has(host) && !path.extname(pathname)) return path.join(base, host + '.html'); // the page routes it
  const f = path.join(base, pathname.slice(1));
  return inside(base, f) ? f : null;
}

// Attributes for every page's <html>: Settings › Accessibility
// (main/accessibility.js), so the first paint already has them.
let pageAttributes = () => '';
function setPageAttributes(fn) { pageAttributes = fn; }

// dark: every page is served dark (incognito tabs). Otherwise a page asks for
// it with ?appearance=dark (an incognito window's shell and overlay).
function makeHandler(hosts, { dark = false } = {}) {
  return async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    const file = resolveFile(url, hosts);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      let body = await fs.promises.readFile(file);
      if (path.basename(file) === CHROMIUM_CREDITS) body = chromiumCreditsHtml(body);
      // Marked in the HTML itself, so the page is dark from its first paint
      // (the CSP allows no inline script to do it).
      if (path.extname(file) === '.html' && (dark || url.searchParams.get('appearance') === 'dark')) {
        body = String(body).replace(/<html\b/i, '<html data-appearance="dark"');
      }
      if (path.extname(file) === '.html') {
        body = localizeHtml(body); // Lumio's language (main/i18n.js)
        const attrs = pageAttributes();
        if (attrs) body = String(body).replace(/<html\b/i, `<html${attrs}`);
      }
      return new Response(body, {
        headers: {
          'content-type': MIME[path.extname(file)] || 'application/octet-stream',
          'content-security-policy': CSP,
          'x-frame-options': 'DENY',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}

// The browser UI lives in the default session; tabs (normal and incognito)
// each get the page hosts only. Incognito tabs' pages are always dark.
function registerUiProtocol(uiSession) {
  uiSession.protocol.handle('lumio', makeHandler(new Set([...UI_HOSTS, ...PAGE_HOSTS])));
}
function registerPagesProtocol(tabSession, { dark = false } = {}) {
  tabSession.protocol.handle('lumio', makeHandler(PAGE_HOSTS, { dark }));
}

module.exports = { registerUiProtocol, registerPagesProtocol, setPageAttributes, PAGE_HOSTS, resolveFile, CSP };
