// Site settings that act on pages (main/site-settings.js has the settings):
//  - JavaScript off: a Content-Security-Policy of script-src 'none' is added
//    to the site's pages and frames, and their scripts aren't fetched. (A tab
//    can't turn JavaScript off for one site after it's created.) Pages from
//    the back/forward cache keep running until they reload.
//  - Images off: image requests from the site's pages are cancelled.
//  - PDFs: downloaded instead of opened when Settings says so (an
//    attachment Content-Disposition makes Chromium save them).
//  - Sound: tabs on a muted site are muted when they get there.
//  - Automatic downloads: a page's second download without a click or a key
//    press in between asks first (or is blocked), like Chrome.
//  - Insecure content: a tab on a site allowed to show it is rebuilt with
//    insecure content allowed, and rebuilt safe again before it leaves.
//  - On-device site data: cookies and site data are deleted when Lumio quits
//    (and when the last window closes on Windows), except for sites allowed.
//  - Third-party cookies (main/privacy.js).
// It also clears a tab's permission questions and "Allow this time" grants
// when the tab moves to another page, and shows what was blocked.
const { originOf, blockedInfo } = require('./site-settings');
const privacy = require('./privacy');

// Site data deleted on exit: everything a site saves, not the cache.
const SITE_DATA = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'];
// Settings a page only picks up when it loads again.
const ON_LOAD = ['javascript', 'images', 'insecureContent'];

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);

class SiteControls {
  // profile: { session, permissions, incognito }. tabs(): every tab of this
  // profile, as [{ w, tab }]. emitFor(wcId, channel, payload) reaches the
  // window showing that tab.
  constructor({ profile, sites, emitFor, tabs }) {
    this.profile = profile;
    this.settings = profile.permissions.settings;
    this.permissions = profile.permissions;
    this.emitFor = emitFor;
    this.tabs = tabs;
    this.pages = new Map(); // wcId -> { downloads, interacted, savedLinks, blocked, loaded }
    this.net = privacy.hooks(profile.session);
    this.unhook = [
      this.net.add(privacy.thirdPartyCookies({ settings: this.settings, sites, incognito: !!profile.incognito })),
      this.net.add(this.imagesHook()),
      this.net.add(this.javascriptHook()),
      this.net.add(this.pdfHook()),
    ];
    this.unwatch = this.settings.onChange((origin, id) => this.changed(origin, id));
  }

  // The incognito profile is thrown away with its windows.
  dispose() {
    this.unhook.forEach((fn) => fn());
    this.unwatch();
    this.settings.dispose();
  }

  page(wcId) {
    if (!this.pages.has(wcId)) this.pages.set(wcId, { downloads: 0, interacted: false, savedLinks: [], blocked: new Set(), loaded: {} });
    return this.pages.get(wcId);
  }

  // Does a setting block `id` on the page this request belongs to?
  blockedOn(details, id) {
    const origin = originOf(privacy.topUrlOf(details));
    return !!origin && /^https?:/.test(origin) && this.settings.value(origin, id) === 'block';
  }
  anyBlocked(id) {
    return this.settings.defaultOf(id) === 'block' || this.settings.effectiveExceptions(id).some((e) => e.value === 'block');
  }

  // A blocked indicator in the address bar, once per page.
  reportBlocked(wcId, id, url) {
    if (wcId == null) return;
    const page = this.page(wcId);
    if (page.blocked.has(id)) return;
    page.blocked.add(id);
    const origin = originOf(url);
    this.emitFor(wcId, 'permission-blocked', { wcId, origin, host: origin ? new URL(origin).host : '', ...blockedInfo(id) });
  }

  imagesHook() {
    return {
      name: 'images',
      active: () => this.anyBlocked('images'),
      beforeRequest: (d) => {
        if (d.resourceType !== 'image' || !this.blockedOn(d, 'images')) return false;
        this.reportBlocked(d.webContentsId, 'images', privacy.topUrlOf(d));
        return true;
      },
    };
  }

  javascriptHook() {
    return {
      name: 'javascript',
      active: () => this.anyBlocked('javascript'),
      beforeRequest: (d) => d.resourceType === 'script' && this.blockedOn(d, 'javascript'),
      headersReceived: (d, headers) => {
        if ((d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') || !this.blockedOn(d, 'javascript')) return false;
        // One more policy on top of the site's own: both apply.
        const key = privacy.headerKeys(headers, 'content-security-policy')[0] || 'Content-Security-Policy';
        headers[key] = [...[].concat(headers[key] || []), "script-src 'none'"];
        return true;
      },
    };
  }

  pdfHook() {
    return {
      name: 'pdf-download',
      active: () => this.settings.defaultOf('pdfDocuments') === 'download',
      headersReceived: (d, headers) => {
        if (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') return false;
        if (!/^application\/pdf\b/i.test(privacy.headerValue(headers, 'content-type'))) return false;
        const disposition = privacy.headerValue(headers, 'content-disposition').trim();
        if (/^attachment\b/i.test(disposition)) return false;
        privacy.dropHeader(headers, 'content-disposition');
        headers['Content-Disposition'] = [!disposition ? 'attachment' : /^inline\b/i.test(disposition) ? disposition.replace(/^inline/i, 'attachment') : `attachment; ${disposition}`];
        return true;
      },
    };
  }

  // A setting changed (origin and id are null for "everything").
  changed(origin, id) {
    this.net.refresh();
    if (!id || id === 'sound') for (const { tab } of this.tabs()) this.applySound(tab);
    // A site that loses JavaScript also loses its service worker, which could
    // otherwise answer for its pages without the policy above.
    if (origin && id === 'javascript' && this.settings.value(origin, 'javascript') === 'block') {
      this.profile.session.clearStorageData({ origin, storages: ['serviceworkers'] }).catch(() => {});
    }
    if (!id || id === 'insecureContent') for (const { tab } of this.tabs()) this.checkInsecure(tab, tab.view?.webContents.getURL());
  }

  // ---------------------------------------------------------------- tabs
  // Called for every tab page Lumio creates (and again after a rebuild).
  attach(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.lumioSiteControls) return;
    wc.lumioSiteControls = true;
    const id = wc.id;
    wc.on('did-navigate', (_e, url) => {
      const page = this.page(id);
      page.downloads = 0;
      page.blocked.clear();
      page.loaded = this.onLoadValues(url);
      this.permissions.navigated(id, url);
      this.emitFor(id, 'permission-reset', { wcId: id });
      const origin = originOf(url);
      if (origin && this.settings.value(origin, 'javascript') === 'block') this.reportBlocked(id, 'javascript', url);
      this.applySound(tab);
      this.checkInsecure(tab, url);
    });
    // Leaving a site allowed to show insecure content: rebuild the tab safe
    // before the next site's page loads.
    const leaving = (details) => { if (details.isMainFrame && !details.isSameDocument) this.checkInsecure(tab, details.url, true); };
    wc.on('did-start-navigation', leaving);
    wc.on('did-redirect-navigation', leaving);
    wc.on('before-input-event', (_e, input) => { if (input.type === 'keyDown') this.page(id).interacted = true; });
    wc.on('before-mouse-event', (_e, mouse) => { if (mouse.type === 'mouseDown') this.page(id).interacted = true; });
    // "Save Link As…" and friends are the person's own downloads.
    wc.on('context-menu', (_e, params) => {
      this.page(id).savedLinks = [params.linkURL, params.srcURL].filter(Boolean).map((url) => ({ url, time: Date.now() }));
    });
    wc.once('destroyed', () => this.pages.delete(id));
    this.applySound(tab);
  }

  onLoadValues(url) {
    const origin = originOf(url);
    return Object.fromEntries(ON_LOAD.map((id) => [id, origin ? this.settings.value(origin, id) : null]));
  }

  // Did a setting change since this page loaded, so it needs a reload?
  needsReload(wc) {
    if (!wc || wc.isDestroyed()) return false;
    const now = this.onLoadValues(wc.getURL());
    const loaded = this.page(wc.id).loaded;
    return ON_LOAD.some((id) => id in loaded && loaded[id] !== now[id]);
  }

  // Sound: a muted site's tabs are muted; Lumio unmutes only tabs it muted.
  applySound(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const origin = originOf(wc.getURL());
    const mute = !!origin && this.settings.value(origin, 'sound') === 'block';
    if (mute && !tab.muted) { wc.setAudioMuted(true); tab.muted = true; tab.siteMuted = true; tab.owner?.changed(); }
    else if (!mute && tab.siteMuted) { wc.setAudioMuted(false); tab.muted = false; tab.siteMuted = false; tab.owner?.changed(); }
  }

  // Insecure content is a setting of the tab's page itself (TabManager asks
  // insecureAllowed when it makes one), so a tab is rebuilt, keeping its
  // history, when it should change: right away when it starts leaving such
  // a site, and once it has arrived on one.
  checkInsecure(tab, url, leaving = false) {
    const view = tab.view;
    if (!view || !url || !tab.owner?.rebuild) return;
    const allowed = this.insecureAllowed(url);
    if (allowed === !!view.lumioInsecure || (leaving && allowed)) return;
    // Not from inside the page's own navigation events: right after them,
    // before the next page can arrive.
    setImmediate(() => { if (tab.view === view && tab.owner) tab.owner.rebuild(tab.id, url); });
  }
  insecureAllowed(url) {
    const origin = originOf(url);
    return !!origin && url.startsWith('https:') && this.settings.value(origin, 'insecureContent') === 'allow';
  }

  // ---------------------------------------------------------------- downloads
  // Downloads.gate: the first download a page starts is fine; another one
  // without a click or key press in between asks (Site settings › Automatic
  // downloads). Downloads the person chose (Save Link As…) never count.
  gate(wc, url) {
    if (!wc || wc.isDestroyed()) return true;
    const origin = originOf(wc.getURL());
    if (!origin) return true;
    const page = this.page(wc.id);
    const now = Date.now();
    if (page.savedLinks.some((l) => l.url === url && now - l.time < 60_000)) return true;
    if (page.interacted) { page.downloads = 0; page.interacted = false; }
    if (page.downloads++ === 0) return true;
    const decision = this.permissions.decision(wc.id, origin, 'automaticDownloads');
    if (decision === 'allow') return true;
    return this.permissions.ask({ wcId: wc.id, origin, cats: ['automaticDownloads'] });
  }

  // ---------------------------------------------------------------- data on exit
  // What closing every window deletes: null (nothing), or clearData options.
  exitPlan() {
    const list = this.settings.exceptionsFor('siteData');
    if (this.settings.defaultOf('siteData') === 'session') {
      const keep = list.filter((e) => e.value === 'allow').map((e) => e.origin);
      return { dataTypes: SITE_DATA, ...(keep.length ? { excludeOrigins: keep } : {}) };
    }
    const doomed = list.filter((e) => e.value === 'session').map((e) => e.origin);
    return doomed.length ? { dataTypes: SITE_DATA, origins: doomed } : null;
  }

  // Deletes what the setting says (never longer than a few seconds).
  async clearSessionData() {
    const plan = this.exitPlan();
    if (!plan) return false;
    await withTimeout(this.profile.session.clearData(plan).catch((err) => console.error('[lumio] clearing site data:', err?.message || err)), 5000);
    return true;
  }

  // Quitting waits for clearSessionData once. Lumio also clears when it
  // starts (main.js), in case it didn't get to finish last time (a crash).
  registerQuit(app) {
    let done = false;
    app.on('will-quit', (e) => {
      if (done || !this.exitPlan()) return;
      done = true;
      e.preventDefault();
      this.clearSessionData().finally(() => app.quit());
    });
  }
}

module.exports = { SiteControls, SITE_DATA };
