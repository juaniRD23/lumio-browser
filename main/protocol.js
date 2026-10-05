// lumio:// serves the browser's own UI and internal pages from disk.
//   lumio://shell/, overlay/, aura/           -> renderer/ui   (default session only)
//   lumio://newtab/, settings, history, downloads, bookmarks, extensions,
//   error, welcome, version, flags-lite                -> renderer/pages (tab sessions)
//   a page's sub-pages (lumio://extensions/shortcuts)  -> that page's HTML
//   */assets/*  -> renderer/assets,  */vendor/* -> whitelisted node_modules files
//   shell/ai-files/* -> pictures Lumio made (userData/ai-files)
//   shell/web/*      -> Lumio Chat's file code (docmaker, attach) and its libraries, copied at build
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'renderer', 'ui');
const PAGES_DIR = path.join(ROOT, 'renderer', 'pages');
const ASSETS_DIR = path.join(ROOT, 'renderer', 'assets');
const VENDOR = {
  'marked.js': path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js'),
  'purify.js': path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs'),
};

const UI_HOSTS = new Set(['shell', 'overlay', 'aura']);
const PAGE_HOSTS = new Set(['newtab', 'settings', 'history', 'downloads', 'bookmarks', 'extensions', 'passwords', 'error', 'welcome', 'version', 'flags-lite']);

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
  // Pictures Lumio made in a chat (the panel only).
  if (pathname.startsWith('/ai-files/') && UI_HOSTS.has(host)) {
    const dir = path.join(require('electron').app.getPath('userData'), 'ai-files');
    const f = path.join(dir, pathname.slice(10));
    return inside(dir, f) ? f : null;
  }
  const base = UI_HOSTS.has(host) ? UI_DIR : PAGES_DIR;
  if (pathname === '/' || pathname === '') return path.join(base, host + '.html');
  if (!UI_HOSTS.has(host) && !path.extname(pathname)) return path.join(base, host + '.html'); // the page routes it
  const f = path.join(base, pathname.slice(1));
  return inside(base, f) ? f : null;
}

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
      // Marked in the HTML itself, so the page is dark from its first paint
      // (the CSP allows no inline script to do it).
      if (path.extname(file) === '.html' && (dark || url.searchParams.get('appearance') === 'dark')) {
        body = String(body).replace(/<html\b/i, '<html data-appearance="dark"');
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

module.exports = { registerUiProtocol, registerPagesProtocol, PAGE_HOSTS, resolveFile, CSP };
