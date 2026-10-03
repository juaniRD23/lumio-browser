// Research without tabs: web_search runs the user's search engine and
// read_url reads a page, both in a hidden page that's never shown (same
// cookies as the user's tabs, no downloads, no permission prompts). One step
// instead of opening a tab, navigating, waiting and reading, and nothing moves
// on screen.
const scripts = require('./page-scripts');
const { inPage, settle, YOUTUBE_VIDEO, videoText } = require('./browser');
const { hidden } = require('../../hidden-pages');

const LOAD_TIMEOUT = 15_000;
const MAX_HIDDEN = 4; // pages loading at once (helpers search in parallel)

let open = 0;
const queue = [];
async function slot() {
  if (open < MAX_HIDDEN) { open++; return; }
  await new Promise((resolve) => queue.push(resolve));
  open++;
}
function release() {
  open--;
  queue.shift()?.();
}

// Loads `url` out of sight, runs `read(wc)` on it, and throws the page away.
async function withHiddenPage(ses, url, read, { signal } = {}) {
  const { BrowserWindow, session } = require('electron');
  await slot();
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { session: ses || session.fromPartition('persist:lumio'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const wc = win.webContents;
  hidden.add(wc);
  try {
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-prevent-unload', (e) => e.preventDefault());
    let failed = null;
    wc.on('did-fail-load', (_e, code, desc, _u, main) => { if (main && code !== -3) failed = desc || `error ${code}`; });
    const abort = () => { if (!wc.isDestroyed()) wc.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    await Promise.race([wc.loadURL(url).catch((err) => { if (!/ERR_ABORTED/.test(err.message)) failed ||= err.message; }), new Promise((r) => setTimeout(r, LOAD_TIMEOUT))]);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw new Error('Stopped.');
    if (failed && !/^https?:/.test(wc.getURL())) throw new Error(`Couldn’t open the page (${failed}).`);
    await settle(wc, 2500);
    return await read(wc);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    release();
  }
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function searchUrl(ctx, query) {
  const template = ctx.tabs.searchTemplate?.() || 'https://www.google.com/search?q=%s';
  return template.replace('%s', encodeURIComponent(query));
}

function formatResults(query, r) {
  const lines = [`Search results for “${query}” (${r.engine}), read in the background:`];
  r.results.forEach((x, i) => lines.push(`${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`));
  if (!r.results.length) lines.push('(no results found on the page)');
  if (r.side) lines.push(`\nSide panel: ${r.side}`);
  if (r.top) lines.push(`\nTop of the results page (answer boxes included): ${r.top}`);
  lines.push('\nAnswer from these snippets if they are enough; otherwise read_url the best results (several in a row is fine).');
  return lines.join('\n');
}

const tools = [
  {
    name: 'web_search',
    risk: 'read',
    icon: 'search',
    description: 'Search the web in the background (no tab opens) and get the top results with snippets.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    label: (a) => `Searching “${String(a.query || '').slice(0, 60)}”`,
    async run(a, ctx) {
      const query = String(a.query || '').trim().slice(0, 400);
      if (!query) return { error: 'Say what to search for.' };
      const r = await withHiddenPage(ctx.tabs.session, searchUrl(ctx, query), (wc) => inPage(wc, scripts.serp, { max: 8 }), { signal: ctx.signal });
      if (r?.blocked) return { error: 'The search engine asked to confirm a person is searching. Open the search in a tab with navigate instead.' };
      return { text: formatResults(query, r), summary: `${r.results.length} results` };
    },
  },
  {
    name: 'read_url',
    risk: 'read',
    icon: 'page',
    description: 'Read a web page’s text in the background, without opening a tab.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    label: (a) => `Reading ${hostOf(String(a.url || '')) || 'a page'}`,
    async run(a, ctx) {
      let url = String(a.url || '').trim();
      if (!/^https?:\/\//i.test(url)) url = /^[\w-]+(\.[\w-]+)+/.test(url) ? `https://${url}` : '';
      if (!url) return { error: 'Give a web address (https://…).' };
      if (/\.pdf($|[?#])/i.test(url)) return { error: 'That’s a PDF. Open it in a tab with navigate, then read_page.' };
      const page = await withHiddenPage(ctx.tabs.session, url, async (wc) => {
        if (YOUTUBE_VIDEO.test(wc.getURL())) {
          const v = await inPage(wc, scripts.youtube, { max: 30000 }).catch(() => null);
          if (v && !v.error) return { url: wc.getURL(), title: v.title, text: videoText(v) };
        }
        return inPage(wc, scripts.snapshot, { max: 0, maxText: 14000 });
      }, { signal: ctx.signal });
      if (!page?.text) return { error: `Nothing readable on ${hostOf(url)}. If it needs signing in or clicking, open it in a tab with navigate.` };
      return { text: `${page.title || hostOf(page.url)}\n${page.url}\n\n${page.text}`, summary: hostOf(page.url) };
    },
  },
];

module.exports = { tools, NAMES: new Set(tools.map((t) => t.name)), formatResults, searchUrl };
