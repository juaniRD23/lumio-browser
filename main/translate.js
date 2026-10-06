// Translate pages. When a page isn't in a language the person reads, the
// address bar shows a translate button and a small bubble offers to
// translate it. Lumio AI does the translating through the Lumio server
// (POST /v1/translate, charged to the weekly allowance like other calls), a
// screen at a time as the person scrolls; the text is swapped in the page's
// own text nodes (main/translate-page.js) and Show original puts it back.
// It needs a Lumio sign-in, and in incognito windows it only translates when
// asked (Always translate doesn't apply there).
const { app } = require('electron');
const { translatePage, languageSample } = require('./translate-page');
const { pageLanguage, baseLang } = require('./translate-detect');

const WORLD = 1003; // its own isolated world (Lumio AI's page tools use 1001)
const MAX_PAGE_CHARS = 200_000; // per page load: an endless feed stops here
const QUIET_PROMPTS = 3; // after this many "Not now"s for a language, only the button shows
// Offered in "Translate to" besides the person's own languages.
const COMMON = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'he', 'hi', 'bn', 'id', 'vi', 'th', 'ja', 'ko', 'zh-CN', 'zh-TW', 'sv', 'da', 'no', 'fi', 'el', 'cs', 'ro', 'hu'];

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const translatable = (url) => /^(https?|file):/i.test(url || '');

// A language to translate into: the base language, except Chinese, where
// Simplified or Traditional matters.
function targetTag(tag) {
  const base = baseLang(tag);
  if (base !== 'zh') return base;
  return /hant|tw|hk|mo/i.test(String(tag)) ? 'zh-TW' : 'zh-CN';
}

function languageName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}

class Translator {
  // windowOf(tab): the BrowserWin a tab is in (tabs can move between windows).
  // pollMs: how often a translated page is checked for new text on screen.
  constructor({ store, account, windowOf, languages = () => [...app.getPreferredSystemLanguages(), app.getLocale()], pollMs = 700 }) {
    this.store = store;
    this.account = account;
    this.windowOf = windowOf;
    this.systemLanguages = languages;
    this.pollMs = pollMs;
    this.wired = new WeakSet();
    this.lastRefresh = 0;
  }

  // ---------------------------------------------------------------- settings
  prefs() {
    const t = this.store.settings.translate || {};
    return { always: list(t.always), never: list(t.never), sites: list(t.sites), target: typeof t.target === 'string' ? t.target : null, declined: t.declined && typeof t.declined === 'object' ? t.declined : {} };
  }
  setPrefs(patch) {
    this.store.setSetting('translate', { ...this.prefs(), ...patch });
  }
  // The languages the person reads (their computer's), most preferred first.
  readLanguages() {
    let tags = [];
    try { tags = this.systemLanguages(); } catch { /* none */ }
    return [...new Set(tags.map(baseLang).filter(Boolean))];
  }
  target() {
    const chosen = this.prefs().target;
    if (chosen) return chosen;
    let tags = [];
    try { tags = this.systemLanguages(); } catch { /* none */ }
    return targetTag(tags.find((t) => baseLang(t)) || 'en') || 'en';
  }
  languages(target) {
    const own = this.readLanguages().map((l) => (l === 'zh' ? targetTag(this.target()) : l));
    return [...new Set([target, ...own, ...COMMON])];
  }

  // ---------------------------------------------------------------- pages
  wire(tab) {
    const wc = tab.view?.webContents;
    if (!wc || this.wired.has(wc)) return;
    this.wired.add(wc);
    // A new page view (a tab Memory Saver put to sleep, waking up): it loads untranslated.
    if (tab.translate) { tab.translate.on = false; tab.translate = null; }
    const mine = () => !wc.isDestroyed() && tab.view?.webContents === wc;
    wc.on('did-navigate', () => { if (mine()) this.forget(tab); });
    wc.on('did-finish-load', () => setTimeout(() => { if (mine()) this.probe(tab, wc); }, 500));
    // A single-page app showed something new: look again, unless it's translating.
    wc.on('did-navigate-in-page', (_e, _url, isMain) => {
      if (isMain && !tab.translate?.on) setTimeout(() => { if (mine()) this.probe(tab, wc); }, 1200);
    });
    // Clicking the page closes the bubble, like clicking anywhere else.
    wc.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type !== 'mouseDown') return;
      const w = this.windowOf(tab);
      if (w?.overlayKind === 'translate') { w.hideOverlay(); w.emit('overlay-picked', { kind: 'translate' }); }
    });
  }

  // A new page in the tab: its own language, its own offer.
  forget(tab) {
    if (tab.translate) tab.translate.on = false;
    tab.translateHold = false;
    if (!tab.translate && !tab.translateSeen) return;
    tab.translate = null;
    tab.translateSeen = false;
    tab.owner.changed();
  }

  async probe(tab, wc) {
    const url = wc.getURL();
    if (!translatable(url) || tab.translate?.on) return;
    let sample;
    try { sample = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${languageSample})()` }]); } catch { return; }
    if (wc.isDestroyed() || tab.view?.webContents !== wc || wc.getURL() !== url || tab.translate?.on) return;
    const { lang, reliable } = pageLanguage(sample || {});
    const before = tab.translate;
    tab.translate = { lang, reliable, target: this.target(), status: null, error: null, gen: before?.gen || 0, on: false };
    tab.translate.status = this.offerFor(tab);
    this.update(tab);
    if (tab.translate.status !== 'offer') return;
    const p = this.prefs();
    // Always translate: every time the page loads, unless the person chose Show original on it.
    const auto = p.always.includes(lang) && !tab.owner.incognito && /^https?:/i.test(url) && this.account.token() && !tab.translateHold; // local files only on request
    if (!auto && tab.translateSeen) return;
    tab.translateSeen = true; // the bubble offers itself once per page
    if (auto) this.start(tab);
    else if ((p.declined[lang] || 0) < QUIET_PROMPTS) tab.owner.emit('translate-prompt', { tabId: tab.id });
  }

  // Whether to offer translating this tab: 'offer', 'never' (the person said
  // not to), or null (it's already in a language they read, or unknown).
  offerFor(tab) {
    const st = tab.translate;
    if (!st?.lang || !st.reliable) return null;
    if (st.lang === baseLang(st.target) || this.readLanguages().includes(st.lang)) return null;
    const p = this.prefs();
    if (p.never.includes(st.lang) || p.sites.includes(hostOf(tab.owner.displayUrl(tab)))) return 'never';
    return 'offer';
  }

  // The tab's state changed: its button in the address bar, and the bubble if it's open on it.
  update(tab) {
    tab.owner.changed();
    const w = this.windowOf(tab);
    if (w && w.overlayKind === 'translate' && w.tabs.activeId === tab.id) w.overlay.webContents.send('overlay-data', this.bubble(w, tab));
  }

  // Something the person should see (sign in first, or an error): the bubble
  // opens on its own if it isn't already (from the right-click menu, or Always translate).
  tell(tab) {
    const w = this.windowOf(tab);
    if (w && w.overlayKind !== 'translate') tab.owner.emit('translate-prompt', { tabId: tab.id });
  }

  run(wc, cmd, arg = {}) {
    return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${translatePage})(${JSON.stringify(cmd)}, ${JSON.stringify(arg)})` }]);
  }

  // Translate the tab, now and as more of it comes into view.
  async start(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed() || !translatable(wc.getURL())) return;
    const st = tab.translate || (tab.translate = { lang: null, reliable: false, status: null, error: null, gen: 0, on: false });
    st.target = this.target();
    st.error = null;
    if (!this.account.token()) { st.status = 'signin'; this.update(tab); this.tell(tab); return; }
    st.on = true;
    st.status = 'translating';
    st.capped = false;
    const gen = ++st.gen;
    this.update(tab);
    try {
      await this.run(wc, 'start', { maxPageChars: MAX_PAGE_CHARS });
    } catch {
      if (st.gen !== gen) return;
      Object.assign(st, { on: false, status: 'error', error: 'This page can’t be translated.' });
      this.update(tab);
      return;
    }
    this.loop(tab, wc, gen);
  }

  async loop(tab, wc, gen) {
    const st = tab.translate;
    const live = () => tab.translate === st && st.gen === gen && st.on && !wc.isDestroyed() && tab.view?.webContents === wc;
    let first = true;
    while (live()) {
      let batch;
      try { batch = await this.run(wc, 'collect', { maxChars: first ? 2500 : 4000 }); } catch { return; } // the page went away
      if (!live()) return;
      if (batch?.blocks?.length) {
        first = false;
        const res = await this.request({ target: st.target, ...(st.lang ? { source: st.lang } : {}), blocks: batch.blocks.map((b) => b.texts) });
        if (!live()) return;
        if (res.error) {
          await this.run(wc, 'release', { ids: batch.blocks.map((b) => b.id) }).catch(() => {});
          Object.assign(st, { on: false, status: res.code === 'sign_in_required' ? 'signin' : 'error', error: res.error });
          this.update(tab);
          this.tell(tab);
          return;
        }
        await this.run(wc, 'apply', { results: batch.blocks.map((b, i) => ({ id: b.id, texts: res.translations[i] })) }).catch(() => {});
        if (st.status !== 'translated') { st.status = 'translated'; this.update(tab); }
        this.usageSoon();
        continue;
      }
      if (st.status === 'translating' || (batch?.capped && !st.capped)) {
        st.status = 'translated';
        st.capped = !!batch?.capped;
        this.update(tab);
      }
      // Nothing new on screen: look again in a moment (less often in the background).
      await sleep(tab.owner.activeId === tab.id ? this.pollMs : this.pollMs * 4);
    }
  }

  async request(body) {
    const token = this.account.token();
    if (!token) return { error: 'Sign in to Lumio to translate pages.', code: 'sign_in_required' };
    let res;
    try {
      res = await this.account.fetch(`${this.account.aiBase}/v1/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      return { error: 'Couldn’t reach Lumio. Check your internet connection.' };
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.ok && Array.isArray(data?.translations)) return { translations: data.translations };
    if (res.status === 401) {
      this.account.refresh().catch(() => {});
      return { error: 'Sign in to Lumio again to translate pages.', code: 'sign_in_required' };
    }
    return { error: data?.error || 'Couldn’t translate this page right now. Try again.', code: data?.code || null };
  }

  // The usage ring follows translating, without asking after every batch.
  usageSoon() {
    if (Date.now() - this.lastRefresh < 20_000) return;
    this.lastRefresh = Date.now();
    this.account.refresh().catch(() => {});
  }

  async restore(tab) {
    const st = tab.translate;
    const wc = tab.view?.webContents;
    if (!st || !wc || wc.isDestroyed()) return;
    tab.translateHold = true;
    st.on = false;
    st.gen++;
    st.error = null;
    st.status = this.offerFor(tab) === 'never' ? 'never' : 'offer';
    await this.run(wc, 'restore').catch(() => {});
    this.update(tab);
  }

  // ---------------------------------------------------------------- the bubble
  bubble(w, tab) {
    const st = tab?.translate || {};
    const url = tab ? w.tabs.displayUrl(tab) : '';
    const host = hostOf(url);
    const p = this.prefs();
    const target = st.on ? st.target : this.target();
    return {
      kind: 'translate',
      tabId: tab?.id ?? null,
      lang: st.lang || null,
      target,
      status: st.status || 'offer',
      error: st.error || null,
      capped: !!st.capped,
      signedIn: !!this.account.token(),
      incognito: !!w.incognito,
      host,
      canTranslate: translatable(url),
      always: !!st.lang && p.always.includes(st.lang),
      never: !!st.lang && p.never.includes(st.lang),
      neverSite: !!host && p.sites.includes(host),
      languages: this.languages(target),
    };
  }

  async act(w, { action, tabId, value, refocus } = {}) {
    const tab = w.tabs.get(Number(tabId)) || w.tabs.active;
    if (!tab) return;
    const st = tab.translate;
    const lang = st?.lang;
    const p = this.prefs();
    const without = (arr, v) => arr.filter((x) => x !== v);
    if (action === 'translate') await this.start(tab);
    else if (action === 'original') await this.restore(tab);
    else if (action === 'always' && lang) {
      this.setPrefs({ always: value ? [...without(p.always, lang), lang] : without(p.always, lang), never: value ? without(p.never, lang) : p.never });
      if (value && !st.on && !w.incognito) await this.start(tab);
    } else if (action === 'never' && lang) {
      this.setPrefs({ never: value ? [...without(p.never, lang), lang] : without(p.never, lang), always: value ? without(p.always, lang) : p.always });
      if (value && st.on) await this.restore(tab);
      else if (st && !st.on) st.status = this.offerFor(tab) || 'offer';
    } else if (action === 'never-site' && !w.incognito) {
      const host = hostOf(w.tabs.displayUrl(tab));
      if (!host) return;
      this.setPrefs({ sites: value ? [...without(p.sites, host), host] : without(p.sites, host) });
      if (value && st?.on) await this.restore(tab);
      else if (st && !st.on) st.status = this.offerFor(tab) || 'offer';
    } else if (action === 'target' && typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value)) {
      this.setPrefs({ target: value });
      if (st?.on) {
        st.on = false;
        st.gen++;
        await this.run(tab.view.webContents, 'reset').catch(() => {});
        await this.start(tab);
      } else if (st) {
        st.target = value;
        st.status = this.offerFor(tab) || 'offer';
      }
    } else if (action === 'dismiss') {
      // "Not now": after a few for one language, Lumio stops offering it by itself.
      if (lang && !w.incognito && st?.status === 'offer') this.setPrefs({ declined: { ...p.declined, [lang]: (p.declined[lang] || 0) + 1 } });
      w.hideOverlay();
      w.emit('overlay-picked', { kind: 'translate', refocus: !!refocus });
      return;
    }
    this.update(tab);
  }

  // Right-click on a page: translate it (or show the original).
  menuItems(w, tab, params) {
    if (params.linkURL || (params.selectionText || '').trim() || params.isEditable || params.mediaType !== 'none') return [];
    if (!translatable(w.tabs.displayUrl(tab)) || !tab.view) return [];
    if (tab.translate?.on) return [{ label: 'Show Original', click: () => this.restore(tab) }];
    if (tab.translate?.lang && tab.translate.lang === baseLang(this.target())) return []; // already in that language
    return [{ label: `Translate to ${languageName(this.target())}`, click: () => this.start(tab) }];
  }

  // Browser UI calls (main.js routes them to the window they came from).
  register({ handle, on }) {
    handle('translate:bubble', (w, tabId) => this.bubble(w, w.tabs.get(Number(tabId)) || w.tabs.active));
    on('translate:action', (w, payload) => { this.act(w, payload || {}); });
    // The bubble was opened from the keyboard: keys go to it, and come back after.
    on('translate:focus', (w) => w.overlay.webContents.focus());
    on('translate:refocus', (w) => w.win.webContents.focus());
  }
}

module.exports = { Translator, targetTag, languageName, WORLD };
