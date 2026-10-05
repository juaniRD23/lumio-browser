// Session-level browser features: user agent, downloads, site permissions.
const { app, shell } = require('electron');
const { isHidden } = require('./hidden-pages');
const { SiteSettings, CATEGORIES, BY_ID, exceptionValues, blockedInfo } = require('./site-settings');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function chromeUserAgent() {
  // Drop the "Electron/x" and app-name tokens so sites treat us like Chrome
  // (Google sign-in and some others refuse embedded-looking browsers).
  return app.userAgentFallback
    .replace(/\s?Electron\/\S+/i, '')
    .replace(/\s?lumio-browser\/\S+/i, '')
    .replace(/\s?Lumio Browser\/\S+/i, '');
}

function uniquePath(dir, name) {
  const safe = (name || 'download').replace(/[/\\:]/g, '_');
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

// Downloads for one session. With a store (normal windows) they're kept as
// download history; incognito downloads are only listed until the app quits.
class Downloads {
  // settings: the app store, for the download folder and "ask where to save".
  // gate(wc, url): true, false, or a promise of either: may this page
  // download now? (Site settings › Automatic downloads, main/site-controls.js.)
  // danger(item, wc): why a file looks risky ({ kind, title, detail }) or
  // null (main/security.js sets it); a risky file waits for Keep or Discard.
  constructor(tabSession, { emit, store = null, settings = null, gate = null }) {
    this.session = tabSession;
    this.items = [];
    this.emit = emit;
    this.store = store;
    this.settings = settings || store;
    this.gate = gate;
    this.danger = null;
    tabSession.on('will-download', (_e, item, wc) => {
      if (isHidden(wc)) { item.cancel(); return; } // Lumio AI reading a page out of sight
      const allowed = this.gate ? this.gate(wc, item.getURL()) : true;
      if (allowed === false) { item.cancel(); return; }
      const prefs = this.settings?.settings || {};
      let dir = app.getPath('downloads');
      try { if (prefs.downloadDir && fs.statSync(prefs.downloadDir).isDirectory()) dir = prefs.downloadDir; } catch { /* folder gone */ }
      const entry = {
        id: crypto.randomUUID(),
        item,
        name: item.getFilename(),
        path: uniquePath(dir, item.getFilename()),
        url: item.getURL(),
        total: item.getTotalBytes(),
        received: 0,
        state: 'progressing',
        paused: false,
        time: Date.now(),
      };
      if (prefs.askDownload) {
        // Electron shows the Save dialog; record where the file really went.
        item.setSaveDialogOptions({ defaultPath: entry.path });
        item.once('updated', () => { const p = item.getSavePath(); if (p) { entry.path = p; entry.name = path.basename(p); } });
      } else {
        item.setSavePath(entry.path);
      }
      entry.danger = this.danger?.(item, wc) || null;
      this.items.unshift(entry);
      if (this.items.length > 30) this.items.pop();
      item.on('updated', (_ev, state) => {
        entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        entry.paused = item.isPaused();
        entry.received = item.getReceivedBytes();
        entry.total = item.getTotalBytes();
        this.push();
      });
      item.once('done', (_ev, state) => {
        entry.state = state; // completed | cancelled | interrupted
        entry.paused = false;
        entry.received = item.getReceivedBytes();
        if (state === 'completed') app.dock?.downloadFinished(entry.path);
        this.persist(entry);
        this.push(true);
      });
      this.persist(entry);
      this.push(true);
      // A risky file waits, unsaved, for Keep or Discard in the downloads bubble.
      if (entry.danger) item.pause();
      // Waiting for the person to allow more downloads from this page.
      if (typeof allowed?.then === 'function') {
        item.pause();
        entry.gated = true;
        allowed.then((ok) => {
          entry.gated = false;
          if (!ok) this.action(entry.id, 'remove');
          else if (item.isPaused() && !entry.danger) item.resume();
        });
      }
    });
  }

  plain(d) {
    const { id, name, path: p, url, total, received, state, paused, time, danger } = d;
    return { id, name, path: p, url, total, received, state, paused, time, ...(danger && state === 'progressing' ? { danger } : {}) };
  }

  persist(entry) { this.store?.saveDownload(this.plain(entry)); }

  // Recent downloads for the toolbar dropdown.
  list() { return this.items.map((d) => this.plain(d)); }

  // Everything for the downloads page: live items plus saved history.
  all() {
    const live = new Map(this.items.map((d) => [d.id, this.plain(d)]));
    const saved = (this.store?.downloads() || []).map((d) => live.get(d.id) || (d.state === 'progressing' ? { ...d, state: 'interrupted' } : d));
    const ids = new Set(saved.map((d) => d.id));
    const out = [...[...live.values()].filter((d) => !ids.has(d.id)), ...saved];
    return out.map((d) => ({ ...d, exists: d.state === 'completed' ? fs.existsSync(d.path) : undefined }));
  }

  push(started = false) {
    const now = Date.now();
    if (!started && now - (this.lastPush || 0) < 200) return;
    this.lastPush = now;
    this.emit('downloads', { items: this.list(), started });
  }

  action(id, what) {
    const entry = this.items.find((d) => d.id === id);
    const saved = entry ? this.plain(entry) : this.all().find((d) => d.id === id);
    if (what === 'clear') { this.items = this.items.filter((d) => d.state === 'progressing'); this.push(true); return; }
    if (!saved) return;
    if (what === 'show') shell.showItemInFolder(saved.path);
    else if (what === 'open') shell.openPath(saved.path);
    else if (what === 'retry' && /^https?:/.test(saved.url)) this.session.downloadURL(saved.url);
    else if (what === 'keep' && entry?.danger) {
      // The person chose to keep a file Lumio warned about.
      entry.danger = null;
      if (entry.state === 'progressing' && !entry.gated && entry.item.isPaused()) entry.item.resume();
      this.push(true);
    } else if (what === 'remove' || what === 'discard') {
      if (entry?.state === 'progressing') entry.item.cancel();
      this.items = this.items.filter((d) => d.id !== id);
      this.store?.removeDownloads([id]);
      this.push(true);
    } else if (entry && entry.state === 'progressing') {
      if (what === 'cancel') entry.item.cancel();
      else if (what === 'pause') entry.item.pause();
      else if (what === 'resume' && !entry.danger && entry.item.canResume()) entry.item.resume();
      this.push(true);
    }
  }

  clearAll() {
    this.items = this.items.filter((d) => d.state === 'progressing');
    this.store?.clearDownloads();
    this.push(true);
  }
}

// What a page may ask for, as site setting categories (main/site-settings.js).
// Anything else is denied.
const ALWAYS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
const CATEGORY_OF = {
  geolocation: 'geolocation',
  notifications: 'notifications',
  'clipboard-read': 'clipboard',
  midi: 'midi',
  midiSysex: 'midi',
  'window-management': 'windowManagement',
  fileSystem: 'fileEditing',
  'idle-detection': 'idleDetection',
  mediaKeySystem: 'protectedContent',
  'background-sync': 'backgroundSync',
  usb: 'usb',
  hid: 'hid',
  serial: 'serial',
};
// Notifications, downloads and screen sharing get Allow / Don't allow; the
// rest also offer "Allow this time", like Chrome.
const NO_ONCE = new Set(['notifications', 'automaticDownloads', 'screenShare']);
// Devices: Lumio's device chooser is the question (main/device-chooser.js),
// so a site may open it unless it's blocked.
const CHOOSERS = new Set(['usb', 'hid', 'serial']);

// The categories a request is about: the camera and the microphone are one
// Electron permission ('media'). A media request for neither is screen
// capture: asked every time, then Lumio's picker chooses what to share.
function categoriesFor(permission, details = {}) {
  if (permission === 'media') {
    const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    const out = [];
    if (types.includes('video') || types.includes('unknown')) out.push('camera');
    if (types.includes('audio') || types.includes('unknown')) out.push('microphone');
    return out.length || details.mediaTypes === undefined ? out : ['screenShare'];
  }
  return CATEGORY_OF[permission] ? [CATEGORY_OF[permission]] : [];
}

const originFrom = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
const hostFrom = (origin) => { try { return new URL(origin).host; } catch { return origin; } };

// Site permissions for one session: the request and check handlers, the
// bubble's pending questions and "Allow this time" grants. Normal windows
// keep choices in settings; incognito keeps them in memory and inherits the
// normal profile's blocks (parent).
class Permissions {
  constructor(tabSession, { store, emitFor, persist = true, parent = null }) {
    this.emitFor = emitFor; // (wcId, channel, payload) -> the window showing that tab
    this.settings = new SiteSettings({ store, persist, parent });
    this.pending = new Map(); // id -> { callbacks, origin, cats, wcId, quiet }
    this.once = new Set(); // "wcId origin category": allowed until the tab leaves the site
    this.nextId = 1;
    this.onGranted = null; // (wcId, cats): a page got what it asked for (capture indicators, main/security.js)

    tabSession.setPermissionCheckHandler((wc, permission, origin, details) => {
      if (isHidden(wc)) return false;
      if (ALWAYS.has(permission)) return true;
      const cats = categoriesFor(permission, details);
      const o = originFrom(origin) || originFrom(details?.requestingUrl);
      if (cats.length === 1 && CHOOSERS.has(cats[0])) return !!o && this.decision(wc?.id, o, cats[0]) !== 'block';
      return cats.length > 0 && !!o && cats.every((c) => this.decision(wc?.id, o, c) === 'allow');
    });

    tabSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (isHidden(wc)) return callback(false);
      if (ALWAYS.has(permission)) return callback(true);
      // Screen sharing always shows Lumio's picker (main.js setupScreenShare),
      // which is the real question; so does reading a file the person picked.
      if (permission === 'display-capture' || (permission === 'fileSystem' && details.fileAccessType === 'readable')) return callback(true);
      const cats = categoriesFor(permission, details);
      const origin = originFrom(details.requestingUrl || wc.getURL());
      if (!cats.length || !origin) return callback(false);
      const detail = permission === 'fileSystem' && details.filePath ? path.basename(details.filePath) : '';
      this.ask({ wcId: wc.id, origin, cats, detail }).then((ok) => {
        if (ok) this.onGranted?.(wc.id, cats);
        callback(ok);
      });
    });
  }

  // 'allow', 'block', 'ask' or 'quiet' for one site in one tab.
  decision(wcId, origin, cat) {
    if (wcId != null && this.once.has(`${wcId} ${origin} ${cat}`)) return 'allow';
    return this.settings.value(origin, cat);
  }

  // Resolves true or false once the site settings or the person decide.
  ask({ wcId, origin, cats, detail = '' }) {
    const values = cats.map((c) => this.decision(wcId, origin, c));
    const blocked = cats.filter((_c, i) => values[i] === 'block');
    if (blocked.length) {
      for (const c of blocked) this.emitFor(wcId, 'permission-blocked', { wcId, origin, host: hostFrom(origin), ...blockedInfo(c) });
      return Promise.resolve(false);
    }
    const open = cats.filter((_c, i) => values[i] !== 'allow');
    if (!open.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      // The same question from the same tab waits for the same answer.
      for (const p of this.pending.values()) {
        if (p.wcId === wcId && p.origin === origin && p.cats.join() === open.join()) { p.callbacks.push(resolve); return; }
      }
      const id = this.nextId++;
      const quiet = open.every((c) => this.decision(wcId, origin, c) === 'quiet');
      this.pending.set(id, { callbacks: [resolve], origin, cats: open, wcId, quiet });
      this.emitFor(wcId, 'permission', {
        id, wcId, origin, host: hostFrom(origin), quiet, detail,
        once: !open.some((c) => NO_ONCE.has(c)),
        cats: open.map((c) => ({ id: c, prompt: BY_ID[c].prompt, chip: BY_ID[c].chip, blocked: BY_ID[c].blocked })),
      });
    });
  }

  // decision: 'allow' (while visiting the site, remembered), 'once' (this
  // time: until the tab leaves the site), 'block' (remembered) or 'dismiss'
  // (no for now; the site may ask again).
  respond(id, decision) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const allow = decision === 'allow' || decision === 'once';
    if (decision === 'allow' || decision === 'block') for (const c of p.cats) this.settings.set(p.origin, c, decision);
    if (decision === 'once') for (const c of p.cats) this.once.add(`${p.wcId} ${p.origin} ${c}`);
    for (const cb of p.callbacks) cb(allow);
    if (decision !== 'dismiss') this.settle(p.wcId);
  }

  // Questions the new answer already settles (another one for the same site).
  settle(wcId) {
    for (const [id, p] of this.pending) {
      if (p.wcId !== wcId) continue;
      const values = p.cats.map((c) => this.decision(wcId, p.origin, c));
      if (!values.every((v) => v === 'allow') && !values.includes('block')) continue;
      this.pending.delete(id);
      for (const cb of p.callbacks) cb(!values.includes('block'));
      this.emitFor(wcId, 'permission-cancel', { id });
    }
  }

  // ---- site settings, for the site info popup ----
  // value: 'allow', 'block', 'session', or 'default' (true and false work too).
  set(origin, permission, value) { return this.settings.set(origin, permission, value); }

  // What the site-info popup shows for an origin: the main permissions, ads
  // and trackers (so a site that breaks can be allowed right there), and
  // anything else this site has its own setting for (inherited in incognito).
  forOrigin(origin) {
    const own = CATEGORIES.filter((c) => this.settings.exception(origin, c.id) !== undefined).map((c) => c.id);
    const ids = ['geolocation', 'camera', 'microphone', 'notifications', 'trackers', ...own];
    return [...new Set(ids)].map((id) => ({
      permission: id,
      label: BY_ID[id].label,
      value: this.settings.exception(origin, id),
      default: this.settings.defaultOf(id),
      options: exceptionValues(BY_ID[id]),
      reload: !!BY_ID[id].reload,
    }));
  }

  // The tab moved on to a new page: questions it asked are moot, and "this
  // time" ends when it leaves the site.
  navigated(wcId, url) {
    const origin = originFrom(url);
    this.dropFor(wcId, { keepOnce: origin });
  }

  // Deny anything still waiting for a tab that navigated away or closed.
  dropFor(wcId, { keepOnce = null } = {}) {
    for (const [id, p] of this.pending) {
      if (p.wcId !== wcId) continue;
      this.pending.delete(id);
      for (const cb of p.callbacks) cb(false);
      this.emitFor(wcId, 'permission-cancel', { id });
    }
    for (const key of this.once) {
      const [w, origin] = key.split(' ');
      if (Number(w) === wcId && origin !== keepOnce) this.once.delete(key);
    }
  }
}

module.exports = { chromeUserAgent, Downloads, Permissions, uniquePath, categoriesFor };
