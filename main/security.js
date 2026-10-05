// Lumio's security and privacy protections, in one place for main.js:
//  - Settings (Settings › Privacy and security › Security and Tracking
//    protection), kept in settings.json as `security`. They aren't synced:
//    each computer keeps its own.
//  - For each profile (normal windows, incognito): the warning pages
//    (main/navigation-guard.js), tracking protection (privacy-extras.js),
//    device choosers (device-chooser.js) and dangerous downloads.
//  - For the app: Safe Browsing's lists (safe-browsing.js), secure DNS
//    (secure-dns.js), client certificates (certificates.js), capture
//    indicators (capture.js), unused site permissions, Password Checkup
//    (password-checkup.js) and Safety check.
const { app, ipcMain, net, shell, webContents } = require('electron');
const path = require('path');
const { SafeBrowsing, SOURCES, downloadDanger } = require('./safe-browsing');
const { NavigationGuard } = require('./navigation-guard');
const { PrivacyExtras, UnusedPermissions } = require('./privacy-extras');
const { DeviceChoosers } = require('./device-chooser');
const { ClientCertificates, certificateManager } = require('./certificates');
const { CaptureTracker } = require('./capture');
const { PasswordCheckup } = require('./password-checkup');
const { PROVIDERS, applySecureDns, testProvider } = require('./secure-dns');
const { BRAND_TARGETS } = require('./lookalike');
const { hostOf } = require('./sites');

const NEWTAB = 'lumio://newtab/';
const DAY = 864e5;

const DEFAULTS = {
  safeBrowsing: 'standard', // 'standard' or 'off' ("No protection")
  httpsFirst: false, // Always use secure connections (off by default, like Chrome)
  secureDns: { on: true, provider: 'os', custom: '' }, // 'os': your current provider, encrypted when it can be
  doNotTrack: false, // like Chrome; most sites ignore it
  gpc: true, // Global Privacy Control: a request some laws make sites honor
  webrtcProtect: true, // calls use only your public address, not your local network's
  autoRevoke: true, // sites not visited for 90 days lose their permissions
};

// Tests point Lumio at their own servers: a Safe Browsing list, names that
// reach this computer, and https ports for HTTPS-First.
const TEST = process.env.LUMIO_TEST ? process.env : {};
if (TEST.LUMIO_HOST_RULES) app.commandLine.appendSwitch('host-resolver-rules', TEST.LUMIO_HOST_RULES);
const testJson = (v) => { try { return JSON.parse(v); } catch { return null; } };
// Tests trust their own self-signed certificate, made when they run: only
// the one whose SHA-256 fingerprint (base64, of the DER) they name.
if (TEST.LUMIO_TEST_TRUST_CERT) {
  const crypto = require('crypto');
  app.on('certificate-error', (event, _wc, _url, _error, cert, callback) => {
    let fp = '';
    try { fp = crypto.createHash('sha256').update(new crypto.X509Certificate(cert.data).raw).digest('base64'); } catch { /* not a certificate */ }
    if (fp && fp === TEST.LUMIO_TEST_TRUST_CERT) { event.preventDefault(); callback(true); }
  });
}

// The settings in use, with defaults filled in. Lookalike warnings come with Safe Browsing.
function readSettings(store) {
  const saved = store.settings.security || {};
  const s = { ...DEFAULTS, ...saved, secureDns: { ...DEFAULTS.secureDns, ...(saved.secureDns || {}) } };
  return { ...s, lookalikes: s.safeBrowsing !== 'off' };
}

// A change from the Settings pages, with anything unexpected left out.
function cleanPatch(patch = {}) {
  const out = {};
  if (['standard', 'off'].includes(patch.safeBrowsing)) out.safeBrowsing = patch.safeBrowsing;
  for (const k of ['httpsFirst', 'doNotTrack', 'gpc', 'webrtcProtect', 'autoRevoke']) if (typeof patch[k] === 'boolean') out[k] = patch[k];
  const d = patch.secureDns;
  if (d && typeof d === 'object') {
    const dns = {};
    if (typeof d.on === 'boolean') dns.on = d.on;
    if (PROVIDERS.some((p) => p.id === d.provider)) dns.provider = d.provider;
    if (typeof d.custom === 'string') dns.custom = d.custom.trim().slice(0, 500);
    if (Object.keys(dns).length) out.secureDns = dns;
  }
  return out;
}

class Security {
  // store: the app store. sites: registrable domains (main/sites.js).
  // passwords: the PasswordManager. updater, extensions(): for Safety check.
  // windows(): open browser windows. findTab(wc) → { w, tab } | null.
  constructor({ store, sites, passwords, updater, extensions, windows, findTab, userData, fetchImpl = (url, opts) => net.fetch(url, opts) }) {
    this.store = store;
    this.sites = sites;
    this.updater = updater;
    this.extensions = extensions;
    this.windows = windows;
    this.findTab = findTab;
    this.fetch = fetchImpl;
    this.profiles = new Set();
    this.unused = null; // normal windows only
    this.lastCheck = null;
    this.cache = { at: 0, visited: new Set(), targets: BRAND_TARGETS };

    const testList = TEST.LUMIO_SAFE_BROWSING;
    this.safeBrowsing = new SafeBrowsing({
      dir: path.join(userData, 'Safe Browsing'),
      fetchImpl,
      sources: testList ? [{ id: 'test', threat: 'phishing', url: testList }] : SOURCES,
    });
    // Saved lists right away, fresh ones a little later (tests only fetch their own).
    if (process.env.LUMIO_TEST && !testList) this.safeBrowsing.load();
    else this.safeBrowsing.start({ delay: testList ? 50 : 20_000 });
    this.ports = testJson(TEST.LUMIO_HTTPS_PORTS) || {};

    this.capture = new CaptureTracker({
      findTab: (wcId) => this.tabById(wcId),
      onChange: (wcId) => this.tabById(wcId)?.tab.owner?.changed(),
    });
    this.certs = new ClientCertificates({ findTab });
    this.checkup = new PasswordCheckup({ store: passwords.store, dir: userData, fetchImpl });
    app.on('select-client-certificate', (e, wc, url, list, callback) => this.certs.select(e, wc, url, list, callback));
    applySecureDns(app, this.settings().secureDns);
  }

  settings() { return readSettings(this.store); }

  tabById(wcId) {
    const wc = wcId != null ? webContents.fromId(wcId) : null;
    return wc && !wc.isDestroyed() ? this.findTab(wc) : null;
  }

  tabsOf(profile) { return this.windows().filter((w) => w.profile === profile).flatMap((w) => w.tabs.tabs); }

  // ---------------------------------------------------------------- profiles
  addProfile(profile) {
    const siteSettings = profile.permissions.settings;
    const settings = () => this.settings();
    profile.security = {
      guard: new NavigationGuard({
        profile, settings, safeBrowsing: this.safeBrowsing, sites: this.sites, ports: this.ports,
        targets: () => this.lookalikeData().targets,
        visited: (host) => this.lookalikeData().visited.has(host.replace(/^www\./, '')),
        isTab: (wcId) => !!this.tabById(wcId),
      }),
      extras: new PrivacyExtras({ profile, settings, siteSettings, sites: this.sites }),
      devices: new DeviceChoosers({ session: profile.session, settings: siteSettings, findTab: this.findTab }),
    };
    profile.permissions.onGranted = (wcId, cats) => this.capture.granted(wcId, cats);
    profile.downloads.danger = (item, wc) => this.downloadDanger(item, wc);
    if (!profile.incognito) {
      this.unused = new UnusedPermissions({ store: this.store, siteSettings });
      const sweep = () => { if (this.settings().autoRevoke) this.unused.sweep(); };
      setTimeout(sweep, 30_000).unref?.();
      setInterval(sweep, DAY).unref?.();
    }
    this.profiles.add(profile);
  }

  // Incognito's windows all closed.
  removeProfile(profile) {
    const s = profile.security;
    if (!s) return;
    s.guard.dispose();
    s.extras.dispose();
    s.devices.dispose();
    this.profiles.delete(profile);
  }

  // Every tab page Lumio makes (and again after a rebuild).
  attach(w, tab) {
    const s = w.profile.security;
    const wc = tab.view?.webContents;
    if (!s || !wc) return;
    s.guard.attach(tab);
    s.extras.attach(tab);
    s.devices.attach(tab);
    if (wc.lumioSecurity) return;
    wc.lumioSecurity = true;
    const id = wc.id;
    wc.on('did-navigate', (_e, url) => {
      this.capture.ended(id); // the page's captures went with it
      if (!w.incognito) this.unused?.visited(url);
    });
    wc.once('destroyed', () => this.capture.ended(id));
  }

  // A tab's page failed to load: Lumio's warning page instead? (main/tabs.js)
  loadFailed(w, wc, code, url) { return !!w.profile.security?.guard.loadFailed(wc, code, url); }

  // What a tab's capture indicators show (main/tabs.js).
  captureOf(tab) {
    const wc = tab.view?.webContents;
    const s = wc && !wc.isDestroyed() ? this.capture.state(wc.id) : null;
    return s ? { camera: s.camera, microphone: s.microphone, screen: s.screen, sharedTo: s.sharedTo } : null;
  }

  // The chooser over a tab closed without an answer.
  overlayClosed(w, kind) {
    if (kind === 'device') w.profile.security?.devices.closed(w);
    if (kind === 'clientcert') this.certs.closed(w);
  }

  // Sites people visit (they don't get lookalike warnings), and the sites
  // lookalikes are compared with: well-known ones and the ones visited most.
  // Worked out from history at most once a minute.
  lookalikeData() {
    if (Date.now() - this.cache.at < 60_000) return this.cache;
    const counts = new Map();
    for (const h of this.store.history()) {
      const host = hostOf(h.url).replace(/^www\./, '');
      if (host) counts.set(host, (counts.get(host) || 0) + 1);
    }
    const often = [...counts].filter(([host, n]) => n >= 5 && host.includes('.')).sort((a, b) => b[1] - a[1]).slice(0, 30)
      .map(([host]) => ({ site: this.sites.cached(host) || host, brand: false }));
    const known = new Set(BRAND_TARGETS.map((t) => t.site));
    this.cache = { at: Date.now(), visited: new Set(counts.keys()), targets: [...BRAND_TARGETS, ...often.filter((t) => !known.has(t.site))] };
    return this.cache;
  }

  // Downloads.danger: why a download looks risky, or null.
  downloadDanger(item, wc) {
    let pageUrl = '';
    try { if (wc && !wc.isDestroyed()) pageUrl = wc.getURL(); } catch { /* closed */ }
    const protect = this.settings().safeBrowsing !== 'off';
    const listed = (url) => {
      const host = protect ? hostOf(url) : '';
      return host ? this.safeBrowsing.check(host, this.sites.cached(host) || '') : null;
    };
    return downloadDanger({ url: item.getURL(), chain: item.getURLChain?.() || [], filename: item.getFilename(), pageUrl, listed });
  }

  // ---------------------------------------------------------------- settings
  set(patch) {
    const clean = cleanPatch(patch);
    const saved = this.store.settings.security || {};
    const next = { ...saved, ...clean };
    if (clean.secureDns) next.secureDns = { ...DEFAULTS.secureDns, ...(saved.secureDns || {}), ...clean.secureDns };
    this.store.setSetting('security', next);
    if (clean.secureDns) applySecureDns(app, this.settings().secureDns);
    for (const p of this.profiles) {
      p.security.extras.refresh();
      if ('webrtcProtect' in clean) for (const t of this.tabsOf(p)) p.security.extras.applyWebRtc(t.view?.webContents);
    }
    if (clean.safeBrowsing === 'standard' && (!process.env.LUMIO_TEST || TEST.LUMIO_SAFE_BROWSING)) this.safeBrowsing.refresh().catch(() => {});
    return this.pageState();
  }

  // What Settings › Security and Tracking protection show.
  pageState() {
    const normal = [...this.profiles].find((p) => !p.incognito);
    const sites = normal?.permissions.settings;
    return {
      ...this.settings(),
      providers: PROVIDERS.map(({ id, name }) => ({ id, name })),
      lists: this.safeBrowsing.status(),
      certManager: !!certificateManager(),
      platform: process.platform,
      trackers: sites?.defaultOf('trackers') || 'block',
      trackerSites: sites?.exceptionsFor('trackers').length || 0,
    };
  }

  // ---------------------------------------------------------------- Safety check
  async safetyCheck() {
    const [update, passwords] = await Promise.all([
      this.updater ? this.updater.check({ manual: true }).catch(() => this.updater.state) : null,
      this.checkup.run().catch(() => ({ error: 'Couldn’t check your passwords. Try again later.' })),
    ]);
    const manager = this.extensions?.();
    const exts = manager?.ece ? manager.list() : [];
    const on = exts.filter((e) => e.enabled);
    this.lastCheck = {
      time: Date.now(),
      update: update && { status: update.status, current: update.current, latest: update.latest, error: update.error || null },
      passwords,
      safeBrowsing: this.settings().safeBrowsing,
      extensions: { on: on.length, unpacked: on.filter((e) => e.type === 'unpacked').map((e) => e.name) },
    };
    return this.safetyState();
  }

  safetyState() {
    return { last: this.lastCheck, unused: this.unused?.list() || [], autoRevoke: this.settings().autoRevoke, safeBrowsing: this.settings().safeBrowsing };
  }

  // ---------------------------------------------------------------- IPC
  // on / handle / internalHandle: main.js's helpers for the browser UI and Lumio's pages.
  registerIpc({ on, internalHandle }) {
    const guardOf = (w) => w.profile.security?.guard;
    // ---- warning pages (renderer/pages/interstitial.*) ----
    internalHandle('page:interstitial', ['interstitial'], ({ sender, w }) => guardOf(w)?.info(sender) || null);
    internalHandle('page:interstitial-act', ['interstitial'], ({ sender, w }, act) => {
      const g = guardOf(w);
      if (!g) return false;
      if (act === 'proceed') return g.proceed(sender);
      if (act === 'suggested') return g.goSuggested(sender);
      if (act === 'back') return g.back(sender, NEWTAB);
      return false;
    });

    // ---- Settings › Security, Tracking protection, Safety check ----
    internalHandle('page:security', ['settings'], () => this.pageState());
    internalHandle('page:security-set', ['settings'], (_ctx, patch) => this.set(patch && typeof patch === 'object' ? patch : {}));
    internalHandle('page:secure-dns-test', ['settings'], (_ctx, template) => testProvider(String(template || ''), this.fetch));
    internalHandle('page:manage-certificates', ['settings'], async () => {
      const where = certificateManager();
      if (!where) return { ok: false, error: 'Your computer’s certificate manager isn’t available.' };
      const error = await shell.openPath(where);
      return error ? { ok: false, error } : { ok: true };
    });
    internalHandle('page:safety-state', ['settings'], () => this.safetyState());
    internalHandle('page:safety-check', ['settings'], () => this.safetyCheck());
    internalHandle('page:unused-undo', ['settings'], (_ctx, origin) => { this.unused?.undo(String(origin || '')); return this.safetyState(); });

    // ---- Password Checkup (Passwords page, Safety check) ----
    const checkupState = (extra = {}) => ({ ...this.checkup.summary(), ...extra, flags: this.checkup.flags() });
    internalHandle('page:password-checkup', ['passwords', 'settings'], () => checkupState());
    internalHandle('page:password-checkup-run', ['passwords', 'settings'], async () => {
      const { error } = await this.checkup.run();
      return checkupState(error ? { error } : {});
    });

    // ---- choosers over a tab (renderer/ui/overlay-security.js) ----
    on('security:choose', (w, { kind, id, value } = {}) => {
      if (kind === 'device') w.profile.security?.devices.answer(Number(id), typeof value === 'string' ? value : null);
      if (kind === 'clientcert') this.certs.answer(Number(id), Number.isInteger(value) ? value : null);
      w.hideOverlay();
      if (kind) w.tabs.wc()?.focus();
    });
    // ---- the capture bar's Stop sharing (renderer/ui/capture-bar.js) ----
    on('capture:stop', (_w, wcId) => this.capture.stop(Number(wcId)));

    // ---- from web pages' preload (preload/internal.js); only a tab's top frame counts ----
    const tabFrame = (e) => (e.senderFrame && e.senderFrame === e.sender.mainFrame ? this.findTab(e.sender) : null);
    ipcMain.on('capture:report', (e, report) => { if (tabFrame(e)) this.capture.report(e.sender.id, report); });
    ipcMain.on('sec:form', (e, url) => { tabFrame(e)?.w.profile.security?.guard.formHint(e.sender.id, url); });
    // Asked once as each page starts, before its scripts run.
    ipcMain.on('sec:flags', (e) => { e.returnValue = { gpc: !!this.settings().gpc }; });
  }
}

module.exports = { Security, readSettings, cleanPatch, DEFAULTS };
