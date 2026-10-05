// Site settings (Settings › Privacy and security › Site settings), like
// Chrome's content settings: each category has a default for every site and
// per-site exceptions. Exceptions are kept per origin in settings.json
// (`sitePermissions`, the name older Lumio used) as true (allow), false
// (block) or 'session' (On-device site data: delete when windows close).
// Incognito keeps its own exceptions in memory and inherits the normal
// profile's: everything for content settings, only blocks for permissions,
// like Chrome.

// kind: 'permission' (a site asks), 'content' (allowed or blocked), 'global'
// (one setting for every site, no exceptions).
// options: the defaults a person can choose; exceptions: what a site can be
// set to. Text is what Settings and the permission bubble say.
const CATEGORIES = [
  {
    id: 'geolocation', label: 'Location', kind: 'permission', group: 'permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually use your location for relevant features or info, like local news or nearby shops.',
    text: { ask: 'Sites can ask for your location', block: 'Don’t allow sites to see your location' },
    lists: { allow: 'Allowed to see your location', block: 'Not allowed to see your location' },
    prompt: 'Know your location', chip: 'Use your location?', blocked: 'Location blocked',
  },
  {
    id: 'camera', label: 'Camera', kind: 'permission', group: 'permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually use your camera for communication features, like video chatting.',
    text: { ask: 'Sites can ask to use your camera', block: 'Don’t allow sites to use your camera' },
    lists: { allow: 'Allowed to use your camera', block: 'Not allowed to use your camera' },
    prompt: 'Use your camera', chip: 'Use your camera?', blocked: 'Camera blocked',
  },
  {
    id: 'microphone', label: 'Microphone', kind: 'permission', group: 'permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually use your microphone for communication features, like video chatting.',
    text: { ask: 'Sites can ask to use your microphone', block: 'Don’t allow sites to use your microphone' },
    lists: { allow: 'Allowed to use your microphone', block: 'Not allowed to use your microphone' },
    prompt: 'Use your microphone', chip: 'Use your microphone?', blocked: 'Microphone blocked',
  },
  {
    // Quiet by default: a crossed-out bell in the address bar instead of a
    // pop-up, because notification prompts are mostly noise.
    id: 'notifications', label: 'Notifications', kind: 'permission', group: 'permissions', default: 'quiet', options: ['ask', 'quiet', 'block'],
    desc: 'Sites usually send notifications to let you know about breaking news or chat messages.',
    text: { ask: 'Sites can ask to send notifications', quiet: 'Use quieter messaging', block: 'Don’t allow sites to send notifications' },
    hints: { quiet: 'Requests show as a small icon in the address bar instead of a pop-up' },
    lists: { allow: 'Allowed to send notifications', block: 'Not allowed to send notifications' },
    prompt: 'Show notifications', chip: 'Send notifications?', blocked: 'Notifications blocked',
  },
  {
    id: 'backgroundSync', label: 'Background sync', kind: 'permission', group: 'more-permissions', default: 'allow', options: ['allow', 'block'],
    desc: 'After you leave a site, it can keep syncing to finish tasks, like uploading photos or sending a chat message.',
    text: { allow: 'Closed sites can finish sending and receiving data', block: 'Don’t allow closed sites to finish sending or receiving data' },
    lists: { allow: 'Allowed to finish sending and receiving data', block: 'Not allowed to finish sending or receiving data' },
  },
  {
    id: 'automaticDownloads', label: 'Automatic downloads', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites might download related files together to save you time. The first file a page downloads never asks.',
    text: { ask: 'Sites can ask to download multiple files', block: 'Don’t allow sites to download multiple files' },
    lists: { allow: 'Allowed to download multiple files', block: 'Not allowed to download multiple files' },
    prompt: 'Download multiple files', chip: 'Download files?', blocked: 'Downloads blocked',
  },
  {
    id: 'protectedContent', label: 'Protected content IDs', kind: 'permission', group: 'more-permissions', default: 'allow', options: ['allow', 'block'],
    desc: 'Sites might play protected content, like movies and music, which can need an ID for your device.',
    text: { allow: 'Sites can play protected content', block: 'Don’t allow sites to play protected content' },
    lists: { allow: 'Allowed to play protected content', block: 'Not allowed to play protected content' },
  },
  {
    id: 'midi', label: 'MIDI devices', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually connect to MIDI devices for features like making and editing music.',
    text: { ask: 'Sites can ask to connect to MIDI devices', block: 'Don’t allow sites to connect to MIDI devices' },
    lists: { allow: 'Allowed to connect to MIDI devices', block: 'Not allowed to connect to MIDI devices' },
    prompt: 'Use your MIDI devices', chip: 'Use MIDI devices?', blocked: 'MIDI blocked',
  },
  {
    id: 'usb', label: 'USB devices', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually connect to USB devices for features like printing or saving to a storage device. Lumio lists the devices it finds and connects only the one you choose.',
    text: { ask: 'Sites can ask to connect to USB devices', block: 'Don’t allow sites to connect to USB devices' },
    lists: { allow: 'Allowed to connect to USB devices', block: 'Not allowed to connect to USB devices' },
  },
  {
    id: 'serial', label: 'Serial ports', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually connect to serial ports for data features, like setting up your network. Lumio lists the devices it finds and connects only the one you choose.',
    text: { ask: 'Sites can ask to connect to serial ports', block: 'Don’t allow sites to connect to serial ports' },
    lists: { allow: 'Allowed to connect to serial ports', block: 'Not allowed to connect to serial ports' },
  },
  {
    id: 'hid', label: 'HID devices', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually connect to HID devices for features that use uncommon keyboards, game controllers and other devices. Lumio lists the devices it finds and connects only the one you choose.',
    text: { ask: 'Sites can ask to connect to HID devices', block: 'Don’t allow sites to connect to HID devices' },
    lists: { allow: 'Allowed to connect to HID devices', block: 'Not allowed to connect to HID devices' },
  },
  {
    id: 'bluetooth', label: 'Bluetooth devices', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually connect to Bluetooth devices for features like setting up a fitness tracker or a smart light bulb. Lumio lists the devices it finds and connects only the one you choose.',
    text: { ask: 'Sites can ask to connect to Bluetooth devices', block: 'Don’t allow sites to connect to Bluetooth devices' },
    lists: { allow: 'Allowed to connect to Bluetooth devices', block: 'Not allowed to connect to Bluetooth devices' },
  },
  {
    id: 'fileEditing', label: 'File editing', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually edit files and folders on your device for features like saving your work automatically.',
    text: { ask: 'Sites can ask to edit files and folders on your device', block: 'Don’t allow sites to edit files or folders on your device' },
    lists: { allow: 'Allowed to edit files and folders', block: 'Not allowed to edit files or folders' },
    prompt: 'Edit files on your device', chip: 'Edit files?', blocked: 'File editing blocked',
  },
  {
    id: 'clipboard', label: 'Clipboard', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually read your clipboard for features like keeping the formatting of text you copied.',
    text: { ask: 'Sites can ask to see text and images on your clipboard', block: 'Don’t allow sites to see text or images on your clipboard' },
    lists: { allow: 'Allowed to see your clipboard', block: 'Not allowed to see your clipboard' },
    prompt: 'See text and images copied to the clipboard', chip: 'See your clipboard?', blocked: 'Clipboard blocked',
  },
  {
    id: 'windowManagement', label: 'Window management', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually use this to open and place windows on your screens, like presentations or documents side by side.',
    text: { ask: 'Sites can ask to manage windows on all your displays', block: 'Don’t allow sites to manage windows on all your displays' },
    lists: { allow: 'Allowed to manage windows on all your displays', block: 'Not allowed to manage windows on all your displays' },
    prompt: 'Manage windows on all your displays', chip: 'Manage windows?', blocked: 'Window management blocked',
  },
  {
    id: 'idleDetection', label: 'Your device use', kind: 'permission', group: 'more-permissions', default: 'ask', options: ['ask', 'block'],
    desc: 'Sites usually notice when you’re using your device to set your status in chat apps.',
    text: { ask: 'Sites can ask to know when you’re using your device', block: 'Don’t allow sites to know when you’re using your device' },
    lists: { allow: 'Allowed to know when you’re using your device', block: 'Not allowed to know when you’re using your device' },
    prompt: 'Know when you’re using this device', chip: 'Know when you’re away?', blocked: 'Device use blocked',
  },
  {
    // Not a setting: asked every time, before Lumio's picker (no group, no exceptions).
    id: 'screenShare', label: 'Screen sharing', kind: 'permission', group: null, default: 'ask', options: ['ask'], exceptions: [],
    desc: 'Sites can ask to see your screen; you choose what to share each time.',
    text: { ask: 'Sites can ask to see your screen' },
    prompt: 'See your screen', chip: 'Share your screen?', blocked: 'Screen sharing blocked',
  },
  {
    id: 'javascript', label: 'JavaScript', kind: 'content', group: 'content', default: 'allow', options: ['allow', 'block'], reload: true,
    desc: 'Sites usually use JavaScript to show interactive features, like video games or web forms.',
    text: { allow: 'Sites can use JavaScript', block: 'Don’t allow sites to use JavaScript' },
    lists: { allow: 'Allowed to use JavaScript', block: 'Not allowed to use JavaScript' },
    blocked: 'JavaScript blocked', blockedNote: 'This page was blocked from using JavaScript.',
  },
  {
    id: 'images', label: 'Images', kind: 'content', group: 'content', default: 'allow', options: ['allow', 'block'], reload: true,
    desc: 'Sites usually show images to illustrate things, like product pictures or news photos.',
    text: { allow: 'Sites can show images', block: 'Don’t allow sites to show images' },
    lists: { allow: 'Allowed to show images', block: 'Not allowed to show images' },
    blocked: 'Images blocked', blockedNote: 'Images were blocked on this page.',
  },
  {
    id: 'popups', label: 'Pop-ups and redirects', kind: 'content', group: 'content', default: 'block', options: ['allow', 'block'],
    desc: 'Sites might send pop-ups to show ads, or use redirects to lead you to sites you may want to avoid.',
    text: { allow: 'Sites can send pop-ups and use redirects', block: 'Don’t allow sites to send pop-ups or use redirects' },
    lists: { allow: 'Allowed to send pop-ups and use redirects', block: 'Not allowed to send pop-ups or use redirects' },
  },
  {
    // Ad networks and tracking services that pages load from other sites
    // (main/privacy-extras.js). The site you're on is never blocked.
    id: 'trackers', label: 'Ads and trackers', kind: 'content', group: 'content', default: 'block', options: ['allow', 'block'], reload: true,
    desc: 'Pages often load ads and trackers from other companies that follow you from site to site. Lumio blocks the well-known ones. If a site doesn’t work right, allow it here.',
    text: { allow: 'Allow ads and trackers on sites', block: 'Block ads and trackers' },
    lists: { allow: 'Allowed to show ads and trackers', block: 'Ads and trackers blocked' },
  },
  {
    id: 'sound', label: 'Sound', kind: 'content', group: 'more-content', default: 'allow', options: ['allow', 'block'],
    desc: 'Sites might play sound for music, videos and other media.',
    text: { allow: 'Sites can play sound', block: 'Mute sites that play sound' },
    lists: { allow: 'Allowed to play sound', block: 'Muted' },
  },
  {
    // Chromium already blocks insecure scripts and frames on secure pages.
    // Allowing a site rebuilds its tab with insecure content allowed, and
    // leaving the site rebuilds it again (main/site-controls.js).
    id: 'insecureContent', label: 'Insecure content', kind: 'content', group: 'more-content', default: 'block', options: ['block'], exceptions: ['allow'], reload: true,
    desc: 'Secure sites might embed content, like scripts or frames, that isn’t secure. Lumio blocks it, unless you allow a site.',
    text: { block: 'Don’t allow sites to show insecure content' },
    lists: { allow: 'Allowed to show insecure content' },
  },
  {
    id: 'siteData', label: 'On-device site data', kind: 'content', group: 'more-content', default: 'allow', options: ['allow', 'session'], exceptions: ['allow', 'session'],
    desc: 'Sites usually save data on your device to keep you signed in or to remember what’s in your shopping cart.',
    text: { allow: 'Allow sites to save data on your device', session: 'Delete data sites have saved to your device when you close all windows' },
    hints: { session: 'Lumio deletes cookies and site data when you quit, except for sites you allow below' },
    lists: { allow: 'Allowed to save data on your device', session: 'Always delete when you close all windows' },
  },
  {
    id: 'thirdPartyCookies', label: 'Third-party cookies', kind: 'content', group: 'content', default: 'block-incognito', options: ['allow', 'block-incognito', 'block'], exceptions: ['allow'],
    desc: 'Sites can use cookies to improve your browsing experience, for example to keep you signed in or to remember items in your shopping cart. Other sites embedded in a page can use cookies too, to track you across sites.',
    text: { allow: 'Allow third-party cookies', 'block-incognito': 'Block third-party cookies in Incognito', block: 'Block third-party cookies' },
    hints: {
      allow: 'Sites embedded in other sites can see your cookies',
      'block-incognito': 'In Incognito, sites embedded in other sites can’t use your cookies',
      block: 'Some site features may not work, like signing in with another site',
    },
    lists: { allow: 'Allowed to use third-party cookies' },
  },
  {
    id: 'pdfDocuments', label: 'PDF documents', kind: 'global', group: 'more-content', default: 'open', options: ['open', 'download'],
    desc: 'Sites sometimes publish PDFs, like documents, contracts and forms.',
    text: { open: 'Open PDFs in Lumio', download: 'Download PDFs' },
  },
  {
    // Applies when a tab's page is created: Electron sets autoplay per tab.
    id: 'autoplay', label: 'Autoplay', kind: 'global', group: 'more-content', default: 'block', options: ['allow', 'block'],
    desc: 'Videos and sounds that start by themselves. Applies to tabs you open after changing it.',
    text: { allow: 'Sites can play sound as soon as they open', block: 'Sites wait until you click or type on the page before playing sound' },
  },
];

const BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
// What the address bar says about something blocked on a page.
const blockedInfo = (id) => ({ cat: id, label: BY_ID[id].blocked || `${BY_ID[id].label} blocked`, note: BY_ID[id].blockedNote || `${BY_ID[id].label} is blocked for this site.` });
// What a site can be set to: allow or block, unless the category says otherwise.
const exceptionValues = (c) => (c.kind === 'global' ? [] : c.exceptions || ['allow', 'block']);

// Older Lumio stored Electron's permission names.
const LEGACY = { media: ['camera', 'microphone'], 'clipboard-read': ['clipboard'], midiSysex: ['midi'], 'idle-detection': ['idleDetection'] };

// An http(s) origin from a URL or a typed site ("example.com" means https).
function originOf(input) {
  let text = String(input || '').trim();
  if (!text || text.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text.replace(/^\/+/, '');
  try {
    const u = new URL(text);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
    return u.origin;
  } catch { return null; }
}

const store2value = (v) => (v === true ? 'allow' : v === false ? 'block' : v === 'session' ? 'session' : undefined);
const value2store = (v) => (v === 'allow' ? true : v === 'block' ? false : v === 'session' ? 'session' : undefined);

class SiteSettings {
  // persist: keep exceptions in settings.json (normal windows) or in memory
  // (incognito). parent: the normal profile's settings, for incognito.
  constructor({ store, persist = true, parent = null } = {}) {
    this.store = store;
    this.persist = persist;
    this.parent = parent;
    this.memory = {};
    this.memoryTimes = {};
    this.listeners = new Set();
    if (persist) this.migrate();
    // Incognito follows the normal profile's changes (defaults are shared)
    // until its windows close (dispose).
    this.unfollow = parent ? parent.onChange((origin, id) => this.changed(origin, id)) : null;
  }

  dispose() { this.unfollow?.(); this.listeners.clear(); }

  // Told when anything changes: (origin | null, category | null).
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(origin, cat) { for (const fn of this.listeners) fn(origin, cat); }

  all() { return this.persist ? (this.store.settings.sitePermissions || {}) : this.memory; }
  times() { return this.persist ? (this.store.settings.siteSettingTimes || {}) : this.memoryTimes; }
  save(all, times) {
    if (this.persist) {
      this.store.setSetting('sitePermissions', all);
      this.store.setSetting('siteSettingTimes', times);
    } else {
      this.memory = all;
      this.memoryTimes = times;
    }
  }

  // ---- defaults (one set for every window; incognito uses the same) ----
  defaultOf(id) {
    const c = BY_ID[id];
    if (!c) return undefined;
    const v = (this.store?.settings.contentDefaults || {})[id];
    return c.options.includes(v) ? v : c.default;
  }
  setDefault(id, value) {
    const c = BY_ID[id];
    if (!c || !c.options.includes(value)) return false;
    const next = { ...(this.store.settings.contentDefaults || {}) };
    if (value === c.default) delete next[id]; else next[id] = value;
    this.store.setSetting('contentDefaults', next);
    this.changed(null, id);
    return true;
  }

  // ---- exceptions ----
  // A site's own setting: 'allow', 'block', 'session' or undefined (the default).
  exception(origin, id) {
    const own = store2value(this.all()[origin]?.[id]);
    if (own !== undefined || !this.parent) return own;
    const inherited = this.parent.exception(origin, id);
    // Incognito never inherits "allowed" for permissions, like Chrome.
    if (BY_ID[id]?.kind === 'permission' && inherited === 'allow') return undefined;
    return inherited;
  }

  // What applies to a site: its exception, or the default.
  value(origin, id) { return this.exception(origin, id) ?? this.defaultOf(id); }

  // value: 'allow', 'block', 'session' (where the category has it), or
  // 'default' / 'ask' / undefined to go back to the default.
  set(origin, id, value) {
    const c = BY_ID[id];
    const o = originOf(origin);
    if (!c || !o || c.kind === 'global') return false;
    const v = value === true ? 'allow' : value === false ? 'block' : value;
    if (v !== undefined && v !== null && v !== 'default' && v !== 'ask' && !exceptionValues(c).includes(v)) return false;
    const all = { ...this.all() };
    const times = { ...this.times() };
    const site = { ...(all[o] || {}) };
    const stored = value2store(v);
    if (stored === undefined) delete site[id]; else site[id] = stored;
    if (Object.keys(site).length) { all[o] = site; times[o] = Date.now(); } else { delete all[o]; delete times[o]; }
    this.save(all, times);
    this.changed(o, id);
    return true;
  }

  // Forget everything set for one site (Site settings › Reset permissions).
  resetSite(origin) {
    const o = originOf(origin);
    if (!o || !this.all()[o]) return false;
    const all = { ...this.all() };
    const times = { ...this.times() };
    delete all[o];
    delete times[o];
    this.save(all, times);
    this.changed(o, null);
    return true;
  }

  // Every site with its own settings: [{ origin, settings: { id: value }, time }].
  sites() {
    const times = this.times();
    return Object.entries(this.all()).map(([origin, raw]) => ({
      origin,
      time: times[origin] || 0,
      settings: Object.fromEntries(Object.entries(raw).filter(([id]) => BY_ID[id]).map(([id, v]) => [id, store2value(v)])),
    })).filter((s) => Object.keys(s.settings).length);
  }

  // The sites with their own setting for one category: [{ origin, value }].
  exceptionsFor(id) {
    return this.sites().filter((s) => s.settings[id] !== undefined).map((s) => ({ origin: s.origin, value: s.settings[id], time: s.time }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }

  // What applies to each site with an exception, counting what incognito
  // inherits: [{ origin, value }].
  effectiveExceptions(id) {
    const own = new Map(this.exceptionsFor(id).map((e) => [e.origin, e.value]));
    if (this.parent) {
      for (const e of this.parent.effectiveExceptions(id)) {
        if (own.has(e.origin) || (BY_ID[id]?.kind === 'permission' && e.value === 'allow')) continue;
        own.set(e.origin, e.value);
      }
    }
    return [...own].map(([origin, value]) => ({ origin, value }));
  }

  // Sites whose settings changed since `from` (all sites without one).
  count({ from = null } = {}) {
    return this.sites().filter((s) => from == null || s.time >= from).length;
  }

  // Delete browsing data › Site settings: forget sites changed since `from`.
  clear({ from = null } = {}) {
    const times = this.times();
    const keep = (o) => from != null && (times[o] || 0) < from;
    const all = Object.fromEntries(Object.entries(this.all()).filter(([o]) => keep(o)));
    const kept = Object.fromEntries(Object.entries(times).filter(([o]) => keep(o)));
    const removed = Object.keys(this.all()).length - Object.keys(all).length;
    this.save(all, kept);
    this.changed(null, null);
    return removed;
  }

  // Older versions stored Electron's permission names; move them to the
  // categories once.
  migrate() {
    const all = this.all();
    let dirty = false;
    const next = {};
    for (const [origin, raw] of Object.entries(all)) {
      const site = {};
      for (const [k, v] of Object.entries(raw || {})) {
        if (LEGACY[k]) { dirty = true; for (const id of LEGACY[k]) if (site[id] === undefined && raw[id] === undefined) site[id] = v; } else site[k] = v;
      }
      if (Object.keys(site).length) next[origin] = site;
    }
    if (dirty) this.store.setSetting('sitePermissions', next);
  }
}

module.exports = { CATEGORIES, BY_ID, SiteSettings, originOf, exceptionValues, blockedInfo };
