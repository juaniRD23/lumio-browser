// Tracking protection (Settings › Privacy and security › Tracking
// protection) and unused site permissions:
//  - Ads and trackers: requests that a page makes to ad networks and
//    tracking services on another site (main/security-lists.js) are
//    stopped. On by default: it only touches other sites embedded in a
//    page, never the site you're on or links you open, and a site can be
//    allowed in Site settings › Ads and trackers.
//  - "Do Not Track" (off by default, like Chrome) and Global Privacy
//    Control (on: it asks sites not to sell or share your data, which some
//    laws require them to honor) are sent with every request; pages also
//    see navigator.globalPrivacyControl (preload/internal.js).
//  - WebRTC: calls and file sharing on sites use only your public network
//    route, so sites can't learn the addresses on your local network
//    (webContents.setWebRTCIPHandlingPolicy). On by default.
//  - Unused site permissions: sites you haven't visited for 90 days lose
//    the permissions you allowed (camera, location…), like Chrome. Safety
//    check lists them, with "Allow again".
const privacy = require('./privacy');
const { TRACKERS } = require('./security-lists');
const { originOf, BY_ID } = require('./site-settings');
const { hostOf } = require('./sites');

const DAY = 864e5;
const UNUSED_DAYS = 90;

// Is a host (or one of its parents) an ad network or tracker?
function trackerMatch(host, set) {
  const labels = String(host || '').toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) if (set.has(labels.slice(i).join('.'))) return true;
  return false;
}

class PrivacyExtras {
  // settings(): Security settings (main/security.js). siteSettings: the
  // profile's SiteSettings. extraTrackers: more hosts (tests).
  constructor({ profile, settings, siteSettings, sites, extraTrackers = [] }) {
    this.profile = profile;
    this.settings = settings;
    this.siteSettings = siteSettings;
    this.sites = sites;
    this.trackers = new Set([...TRACKERS, ...extraTrackers]);
    this.blocked = new Map(); // wcId -> trackers stopped on its current page
    this.net = privacy.hooks(profile.session);
    this.unhook = [this.net.add(this.trackersHook()), this.net.add(this.signalsHook())];
  }

  dispose() { this.unhook.forEach((fn) => fn()); }

  // Settings changed: install or remove the network hooks.
  refresh() { this.net.refresh(); }

  trackersHook() {
    return {
      name: 'trackers',
      active: () => this.siteSettings.defaultOf('trackers') === 'block' || this.siteSettings.effectiveExceptions('trackers').some((e) => e.value === 'block'),
      beforeRequest: async (d) => {
        if (d.resourceType === 'mainFrame') return false;
        const host = hostOf(d.url);
        if (!trackerMatch(host, this.trackers)) return false;
        const top = privacy.topUrlOf(d);
        const origin = /^https?:/i.test(top) ? originOf(top) : null;
        if (!origin || this.siteSettings.value(origin, 'trackers') !== 'block') return false;
        const [mine, theirs] = await Promise.all([this.sites.siteOf(hostOf(top)), this.sites.siteOf(host)]);
        if (!mine || mine === theirs) return false;
        if (d.webContentsId != null) this.blocked.set(d.webContentsId, (this.blocked.get(d.webContentsId) || 0) + 1);
        return true;
      },
    };
  }

  signalsHook() {
    return {
      name: 'privacy-signals',
      active: () => { const s = this.settings(); return !!(s.doNotTrack || s.gpc); },
      beforeSendHeaders: (_d, headers) => {
        const s = this.settings();
        if (s.doNotTrack) { privacy.dropHeader(headers, 'dnt'); headers.DNT = '1'; }
        if (s.gpc) { privacy.dropHeader(headers, 'sec-gpc'); headers['Sec-GPC'] = '1'; }
      },
    };
  }

  // How many trackers were stopped on a tab's page.
  blockedOn(wcId) { return this.blocked.get(wcId) || 0; }

  applyWebRtc(wc) {
    if (!wc || wc.isDestroyed()) return;
    try { wc.setWebRTCIPHandlingPolicy(this.settings().webrtcProtect ? 'default_public_interface_only' : 'default'); } catch { /* older Electron */ }
  }

  // Called for every tab page.
  attach(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.lumioPrivacy) return;
    wc.lumioPrivacy = true;
    const id = wc.id;
    this.applyWebRtc(wc);
    wc.on('did-navigate', () => this.blocked.delete(id));
    wc.once('destroyed', () => this.blocked.delete(id));
  }
}

// ---------------------------------------------------------------- unused permissions
// Normal windows only. Visits are recorded for sites that have settings of
// their own (the only ones that can lose permissions), at most once an hour.
class UnusedPermissions {
  constructor({ store, siteSettings, now = () => Date.now() }) {
    this.store = store;
    this.siteSettings = siteSettings;
    this.now = now;
  }

  lastVisits() { return this.store.settings.siteLastVisit || {}; }
  revoked() { return (this.store.settings.revokedPermissions || []).filter((r) => this.now() - r.time < 30 * DAY); }

  visited(url) {
    const origin = originOf(url);
    if (!origin || !/^https?:/.test(url) || !this.siteSettings.all()[origin]) return;
    const visits = this.lastVisits();
    if (this.now() - (visits[origin] || 0) < 3600_000) return;
    this.store.setSetting('siteLastVisit', { ...visits, [origin]: this.now() });
  }

  // Permissions a site was allowed, that ask by default.
  allowed(origin) {
    return Object.entries(this.siteSettings.all()[origin] || {})
      .filter(([id, v]) => v === true && BY_ID[id]?.kind === 'permission' && this.siteSettings.defaultOf(id) !== 'allow')
      .map(([id]) => id);
  }

  // Removes the permissions of sites not visited for 90 days. Returns what it removed.
  sweep() {
    const visits = this.lastVisits();
    const times = this.siteSettings.times();
    const done = [];
    for (const origin of Object.keys(this.siteSettings.all())) {
      const cats = this.allowed(origin);
      if (!cats.length) continue;
      const last = Math.max(visits[origin] || 0, times[origin] || 0);
      if (!last || this.now() - last < UNUSED_DAYS * DAY) continue;
      for (const c of cats) this.siteSettings.set(origin, c, 'default');
      done.push({ origin, cats, time: this.now() });
    }
    if (done.length) {
      const keep = this.revoked().filter((r) => !done.some((d) => d.origin === r.origin));
      this.store.setSetting('revokedPermissions', [...done, ...keep].slice(0, 50));
    }
    return done;
  }

  // "Allow again": the site gets its permissions back and counts as visited.
  undo(origin) {
    const entry = this.revoked().find((r) => r.origin === origin);
    if (!entry) return false;
    for (const c of entry.cats) this.siteSettings.set(origin, c, 'allow');
    this.store.setSetting('revokedPermissions', this.revoked().filter((r) => r.origin !== origin));
    this.store.setSetting('siteLastVisit', { ...this.lastVisits(), [origin]: this.now() });
    return true;
  }

  // Safety check's list: [{ origin, host, cats: [labels], time }].
  list() {
    return this.revoked().map((r) => ({ origin: r.origin, host: hostOf(r.origin), cats: r.cats.map((c) => BY_ID[c]?.label || c), time: r.time }));
  }
}

module.exports = { PrivacyExtras, UnusedPermissions, trackerMatch, UNUSED_DAYS };
