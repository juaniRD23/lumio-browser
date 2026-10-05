// Reading mode (main side). Finds the article on a page with Mozilla's
// Readability, the library behind Firefox's Reader View: article extraction
// has endless edge cases, and it's well tested on real sites (Apache-2.0, no
// dependencies of its own). It runs in an isolated world on a copy of the
// page, so the page can't see it and isn't changed. The view itself is
// renderer/ui/reading-mode.js; this module also keeps its settings.
const fs = require('fs');

const READABILITY = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const READERABLE = fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8');
const WORLD = 1004; // its own isolated world (translation uses 1003, Lumio AI's tools 1001)
const MAX_HTML = 2_000_000;

// Runs in the page, after Readability's source: the article, with its links
// and pictures made absolute.
function extractArticle() {
  const doc = document.cloneNode(true); // Readability changes what it reads
  const a = new Readability(doc, { charThreshold: 200 }).parse(); // the library's source runs just before this
  if (!a || !a.content) return null;
  return {
    title: a.title || document.title || '',
    byline: a.byline || '',
    siteName: a.siteName || '',
    lang: a.lang || document.documentElement.lang || '',
    dir: a.dir || '',
    content: a.content,
    length: a.length || 0,
    publishedTime: a.publishedTime || '',
  };
}
const EXTRACT = `(() => {\n${READABILITY}\nreturn (${extractArticle})();\n})()`;
// Cheap check run on every page: does it look like an article? (Shows the
// Reading mode button in the address bar.)
const READERABLE_CHECK = `(() => {\n${READERABLE}\nreturn isProbablyReaderable(document);\n})()`;

const CHOICES = { font: ['sans', 'serif'], spacing: ['tight', 'normal', 'loose'], theme: ['auto', 'light', 'dark', 'sepia'] };
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const DEFAULTS = { font: 'sans', size: 17, spacing: 'normal', theme: 'auto', speed: 1 };
const readable = (url) => /^(https?|file):/i.test(url || '');

// Reading settings from anywhere (the view, an old settings file): only known values.
function cleanPrefs(p = {}) {
  const out = { ...DEFAULTS };
  for (const [k, options] of Object.entries(CHOICES)) if (options.includes(p[k])) out[k] = p[k];
  if (Number.isInteger(p.size) && p.size >= 12 && p.size <= 32) out.size = p.size;
  if (SPEEDS.includes(p.speed)) out.speed = p.speed;
  return out;
}

class Reader {
  constructor({ store }) {
    this.store = store;
    this.wired = new WeakSet();
  }

  prefs() { return cleanPrefs(this.store.settings.reader || {}); }
  setPrefs(patch = {}) {
    const next = cleanPrefs({ ...this.prefs(), ...patch });
    this.store.setSetting('reader', next);
    return next;
  }

  // Notes whether each page looks like an article, for the address bar button.
  wire(tab) {
    const wc = tab.view?.webContents;
    if (!wc || this.wired.has(wc)) return;
    this.wired.add(wc);
    const mine = () => !wc.isDestroyed() && tab.view?.webContents === wc;
    const check = (delay) => setTimeout(async () => {
      if (!mine() || !readable(wc.getURL())) return;
      const url = wc.getURL();
      const yes = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: READERABLE_CHECK }]).catch(() => false);
      if (!mine() || wc.getURL() !== url || !!tab.readerable === !!yes) return;
      tab.readerable = !!yes;
      tab.owner.changed();
    }, delay);
    wc.on('did-navigate', () => { if (mine() && tab.readerable) { tab.readerable = false; tab.owner.changed(); } });
    wc.on('did-finish-load', () => check(700));
    wc.on('did-navigate-in-page', (_e, _url, isMain) => { if (isMain) check(1500); });
  }

  // The article on a tab, for the view.
  async article(w, tab) {
    const url = tab ? w.tabs.displayUrl(tab) : '';
    const base = { tabId: tab?.id ?? null, url, prefs: this.prefs(), incognito: !!w.incognito };
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed() || !readable(wc.getURL())) return { ...base, ok: false, reason: 'Reading mode works on articles and other web pages.' };
    if (tab.pdf) return { ...base, ok: false, reason: 'Reading mode doesn’t work on PDFs.' };
    let a = null;
    try { a = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: EXTRACT }]); } catch { /* not an article, or the page refused */ }
    if (!a || typeof a.content !== 'string' || a.length < 200 || a.content.length > MAX_HTML) return { ...base, ok: false, reason: 'Lumio couldn’t find an article on this page.' };
    return { ...base, ok: true, article: a };
  }

  // Right-click on a page (or on text): open it in reading mode.
  menuItems(w, tab, params) {
    if (params.linkURL || params.isEditable || params.mediaType !== 'none' || !tab.view || !readable(w.tabs.displayUrl(tab))) return [];
    // The view takes the keyboard, so the article scrolls with the arrow keys.
    return [{ label: 'Open in Reading Mode', click: () => { w.win.webContents.focus(); w.emit('reader-open', { tabId: tab.id }); } }];
  }

  register({ handle, on }) {
    handle('reader:article', (w, tabId) => this.article(w, w.tabs.get(Number(tabId)) || w.tabs.active));
    handle('reader:prefs', () => this.prefs());
    on('reader:set-prefs', (_w, patch) => { this.setPrefs(patch && typeof patch === 'object' ? patch : {}); });
  }
}

module.exports = { Reader, cleanPrefs, extractArticle, EXTRACT, READERABLE_CHECK, WORLD };
