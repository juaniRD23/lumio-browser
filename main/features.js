// Session-level browser features: user agent, downloads, site permissions.
const { app, shell } = require('electron');
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
  constructor(tabSession, { emit, store = null, settings = null }) {
    this.session = tabSession;
    this.items = [];
    this.emit = emit;
    this.store = store;
    this.settings = settings || store;
    tabSession.on('will-download', (_e, item) => {
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
    });
  }

  plain(d) {
    const { id, name, path: p, url, total, received, state, paused, time } = d;
    return { id, name, path: p, url, total, received, state, paused, time };
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
    else if (what === 'remove') {
      if (entry?.state === 'progressing') entry.item.cancel();
      this.items = this.items.filter((d) => d.id !== id);
      this.store?.removeDownloads([id]);
      this.push(true);
    } else if (entry && entry.state === 'progressing') {
      if (what === 'cancel') entry.item.cancel();
      else if (what === 'pause') entry.item.pause();
      else if (what === 'resume' && entry.item.canResume()) entry.item.resume();
      this.push(true);
    }
  }

  clearAll() {
    this.items = this.items.filter((d) => d.state === 'progressing');
    this.store?.clearDownloads();
    this.push(true);
  }
}

// Permissions a page may ask for; everything else is denied.
const ASKABLE = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'display-capture', 'idle-detection']);
const ALWAYS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'window-management']);
const SITE_LABELS = {
  geolocation: 'Location',
  media: 'Camera and microphone',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard',
  midi: 'MIDI devices',
};
const LABELS = {
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  'clipboard-read': 'see text and images copied to the clipboard',
  'display-capture': 'see your screen',
  'idle-detection': 'know when you are away',
};

// Site permissions for one session. Normal windows remember choices in
// settings; incognito keeps them in memory only.
class Permissions {
  constructor(tabSession, { store, emitFor, persist = true }) {
    this.store = store;
    this.emitFor = emitFor; // (wcId, channel, payload) -> the window showing that tab
    this.persist = persist;
    this.memory = {};
    this.pending = new Map();
    let nextId = 1;

    tabSession.setPermissionCheckHandler((_wc, permission, origin) => {
      if (ALWAYS.has(permission)) return true;
      return this.remembered(origin, permission) === true;
    });

    tabSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (ALWAYS.has(permission)) return callback(true);
      if (!ASKABLE.has(permission)) return callback(false);
      let origin;
      try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { return callback(false); }
      const saved = this.remembered(origin, permission);
      if (saved !== undefined) return callback(saved);
      const id = nextId++;
      let label = LABELS[permission] || permission;
      if (permission === 'media') {
        const types = details.mediaTypes || [];
        label = types.includes('video') && types.includes('audio') ? 'use your camera and microphone'
          : types.includes('video') ? 'use your camera' : 'use your microphone';
      }
      this.pending.set(id, { callback, origin, permission, wcId: wc.id });
      this.emitFor(wc.id, 'permission', { id, origin, host: new URL(origin).host, permission, label, wcId: wc.id });
    });
  }

  all() { return this.persist ? (this.store.settings.sitePermissions || {}) : this.memory; }

  remembered(origin, permission) {
    return this.all()[origin]?.[permission];
  }

  // value: true (allow), false (block) or undefined (ask again).
  set(origin, permission, value) {
    const all = { ...this.all() };
    const site = { ...(all[origin] || {}) };
    if (value === undefined) delete site[permission]; else site[permission] = !!value;
    if (Object.keys(site).length) all[origin] = site; else delete all[origin];
    if (this.persist) this.store.setSetting('sitePermissions', all); else this.memory = all;
  }

  // What the site-info popup shows for an origin.
  forOrigin(origin) {
    const saved = this.all()[origin] || {};
    const perms = ['geolocation', 'media', 'notifications', 'clipboard-read', 'midi'];
    return perms.map((p) => ({ permission: p, label: SITE_LABELS[p], value: saved[p] }));
  }

  respond(id, allow, remember = true) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (remember) this.set(p.origin, p.permission, !!allow);
    p.callback(!!allow);
  }

  clear() {
    if (this.persist) this.store.setSetting('sitePermissions', {}); else this.memory = {};
  }

  // Deny anything still waiting for a tab that navigated away or closed.
  dropFor(wcId) {
    for (const [id, p] of this.pending) {
      if (p.wcId === wcId) { this.pending.delete(id); p.callback(false); this.emitFor(wcId, 'permission-cancel', { id }); }
    }
  }
}

module.exports = { chromeUserAgent, Downloads, Permissions, uniquePath };
