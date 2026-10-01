// lumio:// serves the browser's own UI and internal pages from disk.
//   lumio://shell/, overlay/, aura/           -> renderer/ui   (default session only)
//   lumio://newtab/, settings, history, downloads, bookmarks, extensions,
//   error                                     -> renderer/pages (tab sessions)
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
const PAGE_HOSTS = new Set(['newtab', 'settings', 'history', 'downloads', 'bookmarks', 'extensions', 'passwords', 'error']);

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
  const f = path.join(base, pathname.slice(1));
  return inside(base, f) ? f : null;
}

function makeHandler(hosts) {
  return async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    const file = resolveFile(url, hosts);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
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
// each get the page hosts only.
function registerUiProtocol(uiSession) {
  uiSession.protocol.handle('lumio', makeHandler(new Set([...UI_HOSTS, ...PAGE_HOSTS])));
}
function registerPagesProtocol(tabSession) {
  tabSession.protocol.handle('lumio', makeHandler(PAGE_HOSTS));
}

module.exports = { registerUiProtocol, registerPagesProtocol, PAGE_HOSTS, resolveFile };
