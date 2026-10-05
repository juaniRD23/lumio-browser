// Chrome extensions for normal (non-incognito) windows.
//  - electron-chrome-extensions (GPL-3.0) provides chrome.tabs/windows/action,
//    toolbar buttons and popups on top of Electron's built-in support.
//  - electron-chrome-web-store lets chromewebstore.google.com install and
//    update extensions. Every install asks the user first.
// Disabled extensions stay on disk but aren't loaded. Unpacked extensions
// ("Load unpacked" in developer mode) are remembered by path in settings.
// What the person decides per extension (all in settings, by extension ID or,
// for unpacked ones, folder):
//   pinnedExtensions      IDs shown on the toolbar (the rest are in the puzzle menu)
//   extensionAccess       site access: { mode: 'click' | 'sites' | 'all', sites }
//   extensionFileAccess   may read file:// pages
//   extensionShortcuts    keyboard shortcuts for its commands
// Site access is applied by loading a limited copy (main/extension-access.js).
// Electron can't load extensions in incognito's in-memory session, so
// extensions never run there.
const { app, session: electronSession, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension, updateExtensions } = require('electron-chrome-web-store');
const access = require('./extension-access');
const commands = require('./extension-commands');
const { packExtension } = require('./extension-pack');
const shims = require('./extension-shims');

const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com';
const MAC = process.platform === 'darwin';
const PLATFORM = { mac: MAC, win: process.platform === 'win32' };

// Installs are loaded one by one (not with loadAllExtensions) so disabled ones never start.
const findInstall = (() => {
  // findExtensionInstall isn't exported from the package root; reimplement the
  // small part we need: the newest version folder under Extensions/<id>/
  // (not Lumio's limited copies).
  const newest = (dir) => {
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(access.RESTRICTED_SUFFIX)) continue;
      const p = path.join(dir, name);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'), 'utf8'));
        if (!best || compareVersions(manifest.version, best.manifest.version) > 0) best = { path: p, manifest };
      } catch { /* not an extension folder */ }
    }
    return best;
  };
  return (id, root) => {
    const dir = path.join(root, id);
    try { return fs.statSync(dir).isDirectory() ? newest(dir) : null; } catch { return null; }
  };
})();

function compareVersions(a = '0', b = '0') {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Resolve __MSG_name__ strings from the extension's _locales folder.
function localize(extPath, manifest, value) {
  const m = /^__MSG_(\w+)__$/.exec(value || '');
  if (!m) return value || '';
  const key = m[1].toLowerCase();
  const locales = [app.getLocale().replace('-', '_'), app.getLocale().split('-')[0], manifest.default_locale, 'en'].filter(Boolean);
  for (const loc of locales) {
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(extPath, '_locales', loc, 'messages.json'), 'utf8'));
      const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === key);
      if (hit) return hit[1].message;
    } catch { /* try the next locale */ }
  }
  return value;
}

function iconDataUrl(extPath, manifest) {
  const icons = manifest.icons || manifest.action?.default_icon || manifest.browser_action?.default_icon || {};
  const entries = typeof icons === 'string' ? [[128, icons]] : Object.entries(icons).map(([k, v]) => [Number(k), v]);
  entries.sort((a, b) => b[0] - a[0]);
  for (const [, rel] of entries) {
    const file = path.join(extPath, String(rel).replace(/^\//, ''));
    if (!file.startsWith(extPath)) continue;
    try {
      const data = fs.readFileSync(file);
      const type = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      return `data:${type};base64,${data.toString('base64')}`;
    } catch { /* next size */ }
  }
  return null;
}

const readManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; } };

// The same folder, even if one path went through a symlink (/var and
// /private/var on the Mac); otherwise every load would look like someone else's.
function samePath(a, b) {
  if (!a || !b) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; }
}

class ExtensionManager {
  constructor({ session, store, hooks }) {
    this.session = session;
    this.store = store;
    // createTab, selectTab, removeTab, createWindow, removeWindow, changed,
    // activate (run an extension's toolbar button), commandsChanged, toast
    this.hooks = hooks;
    this.reservedKeys = () => []; // canonical keys Lumio's own menu uses (set by main/extensions-ui.js)
    this.root = path.join(app.getPath('userData'), 'Extensions');
    this.ece = null;
    this.errors = new Map(); // id or path -> last load error
    this.loadedVia = new Map(); // id -> the folder Lumio loaded it from
    this.justAdded = null; // { id, name } while a Web Store install finishes
  }

  get api() { return this.session.extensions; }
  get settings() { return this.store.settings; }

  async init() {
    // Lumio's stand-ins for APIs Electron lacks; registered first so they're
    // in place before electron-chrome-extensions seals the chrome object.
    shims.attach(this.session);
    this.ece = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: this.session,
      createTab: (details) => this.hooks.createTab(details),
      selectTab: (wc) => this.hooks.selectTab(wc),
      removeTab: (wc) => this.hooks.removeTab(wc),
      createWindow: (details) => this.hooks.createWindow(details),
      removeWindow: (win) => this.hooks.removeWindow(win),
    });
    // Toolbar icons are served over crx:// to the browser UI (default session).
    ElectronChromeExtensions.handleCRXProtocol(electronSession.defaultSession);
    this.ece.on('browser-action-popup-created', (popup) => this.fitPopup(popup));
    shims.register(this);

    await installChromeWebStore({
      session: this.session,
      extensionsPath: this.root,
      loadExtensions: false,
      autoUpdate: !process.env.LUMIO_TEST,
      beforeInstall: (details) => this.confirmInstall(details),
    });

    this.api.on('extension-loaded', (_e, ext) => this.onLoaded(ext));
    this.api.on('extension-unloaded', () => { this.hooks.changed(); this.hooks.commandsChanged?.(); });
    await this.loadAll();
    // Before pinning existed every extension was on the toolbar; keep it so.
    if (!Array.isArray(this.settings.pinnedExtensions)) this.store.setSetting('pinnedExtensions', this.api.getAllExtensions().map((e) => e.id));
  }

  // The library sizes popups from Electron's 'preferred-size-changed' event,
  // which Electron 43 doesn't send for them. So measure the page ourselves:
  // its natural width, then its height at that width. Keep re-measuring while
  // it's open, since many popups render their content after load.
  fitPopup(popup) {
    const measure = `(() => {
      const html = document.documentElement;
      const prev = html.style.width;
      html.style.width = 'max-content';
      const width = Math.ceil(html.getBoundingClientRect().width);
      html.style.width = prev;
      return width;
    })()`;
    let last = '';
    const fit = async () => {
      const win = popup.browserWindow;
      if (popup.isDestroyed() || !win || win.isDestroyed()) return false;
      const wc = win.webContents;
      if (popup.hidden) popup.setSize({ width: 800, height: 600 });
      const width = Math.max(40, await wc.executeJavaScript(measure).catch(() => 0));
      if (popup.isDestroyed()) return false;
      if (popup.hidden) popup.setSize({ width, height: 600 });
      const height = Math.max(30, await wc.executeJavaScript('Math.ceil(document.documentElement.getBoundingClientRect().height)').catch(() => 0));
      if (popup.isDestroyed()) return false;
      const key = `${width}x${height}`;
      if (key !== last || popup.hidden) {
        last = key;
        popup.setSize({ width, height });
        popup.updatePosition();
      }
      if (popup.hidden) popup.show();
      return true;
    };
    popup.whenReady().then(async () => {
      for (let i = 0; ; i++) {
        if (!(await fit())) return;
        await new Promise((r) => setTimeout(r, i < 8 ? 250 : 1000));
      }
    });
  }

  async startWorker(ext) {
    if (ext?.manifest?.manifest_version === 3 && ext.manifest.background?.service_worker) {
      await this.session.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}`).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- loading
  isUnpacked(key) { return (this.settings.unpackedExtensions || []).includes(key); }
  storeIds() { try { return fs.readdirSync(this.root).filter((n) => /^[a-p]{32}$/.test(n)); } catch { return []; } }
  // The extension's own folder (not a limited copy).
  sourceDir(key) { return this.isUnpacked(key) ? key : findInstall(key, this.root)?.path || null; }
  // The key settings use for a loaded extension: its folder if unpacked, else its ID.
  keyOf(ext) { return (this.settings.unpackedExtensions || []).find((p) => p === ext.path) || ext.id; }
  loadedFor(key) { return this.isUnpacked(key) ? this.api.getAllExtensions().find((e) => e.path === key) || null : this.api.getExtension(key); }

  siteAccess(key) {
    const a = (this.settings.extensionAccess || {})[key];
    return a && access.ACCESS_MODES.includes(a.mode) ? { mode: a.mode, sites: Array.isArray(a.sites) ? a.sites : [] } : { mode: 'all', sites: [] };
  }
  fileAccess(key) { return !!(this.settings.extensionFileAccess || {})[key]; }

  // Loads one extension the way the person set it up: limited to its sites,
  // and with file access only if allowed.
  async load(key) {
    const dir = this.sourceDir(key);
    if (!dir) throw new Error('Folder or manifest.json is missing');
    const manifest = readManifest(dir);
    const limits = this.siteAccess(key);
    let target = dir;
    if (limits.mode !== 'all' && !this.isUnpacked(key) && access.canRestrict(manifest)) {
      target = access.buildRestrictedCopy(dir, dir + access.RESTRICTED_SUFFIX, { ...limits, files: this.fileAccess(key) });
    }
    // Noted first, so onLoaded knows this load is Lumio's own (an unpacked
    // extension's ID is only known once it's loaded).
    if (!this.isUnpacked(key)) this.loadedVia.set(key, target);
    const ext = await this.api.loadExtension(target, { allowFileAccess: this.fileAccess(key) });
    this.loadedVia.set(ext.id, target);
    this.errors.delete(key);
    await this.startWorker(ext);
    return ext;
  }

  async loadAll() {
    const disabled = new Set(this.settings.disabledExtensions || []);
    for (const id of this.storeIds()) {
      if (disabled.has(id) || this.api.getExtension(id)) continue;
      try { await this.load(id); } catch (err) { this.errors.set(id, err.message); }
    }
    for (const dir of this.settings.unpackedExtensions || []) {
      if (disabled.has(dir)) continue;
      try { await this.load(dir); } catch (err) { this.errors.set(dir, err.message); }
    }
  }

  // An extension started: its keyboard shortcuts go in the menu and in
  // chrome.commands.getAll().
  onLoaded(ext) {
    this.hooks.changed();
    this.syncCommandLabels(ext.id);
    this.hooks.commandsChanged?.();
    if (this.justAdded?.id === ext.id) {
      this.hooks.toast?.(`Added “${this.justAdded.name}”. Pin it to the toolbar from the extensions menu.`);
      this.justAdded = null;
    }
    // Something else loaded it (the Web Store's updater after an update, or a
    // reinstall): put Lumio's limits back, and clear out the old version.
    if (samePath(this.loadedVia.get(ext.id), ext.path)) return;
    this.loadedVia.set(ext.id, ext.path);
    const key = this.keyOf(ext);
    if (key !== ext.id) return;
    this.pruneVersions(ext.id, ext.path);
    if (this.siteAccess(key).mode !== 'all' || this.fileAccess(key)) setImmediate(() => this.reload(key).catch(() => {}));
  }

  // Old version folders of a Web Store extension (the updater leaves the
  // original behind when it replaced Lumio's limited copy).
  pruneVersions(id, keep) {
    const newest = findInstall(id, this.root);
    if (!newest) return;
    const dir = path.join(this.root, id);
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (p === keep || p === newest.path || p === newest.path + access.RESTRICTED_SUFFIX) continue;
      fs.rmSync(p, { recursive: true, force: true });
    }
  }

  async confirmInstall(details) {
    // The library only checks that the page's origin *starts with* the store's.
    if (details.frame?.origin !== WEBSTORE_ORIGIN) return { action: 'deny' };
    const m = details.manifest || {};
    const warnings = access.describePermissions(m);
    const limits = access.limitations(m);
    const win = details.browserWindow || BrowserWindow.getFocusedWindow();
    const opts = {
      type: 'question',
      buttons: ['Add extension', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Add “${details.localizedName}” to Lumio Browser?`,
      detail: (warnings.length ? `It can:\n• ${warnings.join('\n• ')}` : 'It doesn’t ask for any special permissions.')
        + (limits.length ? `\n\nMay not work fully in Lumio:\n• ${limits.join('\n• ')}` : ''),
      icon: details.icon && !details.icon.isEmpty() ? details.icon : undefined,
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (response === 0) this.justAdded = { id: details.id, name: details.localizedName };
    return { action: response === 0 ? 'allow' : 'deny' };
  }

  // ---------------------------------------------------------------- what the pages show
  // Everything the extensions page shows: loaded, disabled and unpacked.
  list() {
    const disabled = new Set(this.settings.disabledExtensions || []);
    const pinned = new Set(this.pinned());
    const out = [];
    const add = (id, extPath, manifest, { enabled, type }) => {
      const key = type === 'unpacked' ? extPath : id;
      out.push({
        id,
        key,
        name: localize(extPath, manifest, manifest.name),
        description: localize(extPath, manifest, manifest.description),
        version: manifest.version,
        type,
        path: extPath,
        enabled,
        icon: iconDataUrl(extPath, manifest),
        options: manifest.options_page || manifest.options_ui?.page || null,
        error: this.errors.get(key) || null,
        hasAction: !!(manifest.action || manifest.browser_action || manifest.page_action),
        pinned: !!id && pinned.has(id),
        siteAccess: access.wantsSites(manifest) ? this.siteAccess(key).mode : null,
      });
    };
    const loaded = new Map(this.api.getAllExtensions().map((e) => [e.id, e]));
    for (const id of this.storeIds()) {
      const found = findInstall(id, this.root);
      if (loaded.has(id)) { const ext = loaded.get(id); add(id, found?.path || ext.path, found?.manifest || ext.manifest, { enabled: true, type: 'store' }); loaded.delete(id); continue; }
      if (found) add(id, found.path, found.manifest, { enabled: !disabled.has(id), type: 'store' });
    }
    for (const dir of this.settings.unpackedExtensions || []) {
      const ext = [...loaded.values()].find((e) => e.path === dir);
      if (ext) { add(ext.id, dir, ext.manifest, { enabled: true, type: 'unpacked' }); loaded.delete(ext.id); continue; }
      const manifest = readManifest(dir);
      if (manifest) add(null, dir, manifest, { enabled: false, type: 'unpacked' });
      else out.push({ id: null, key: dir, name: path.basename(dir), description: '', version: '', type: 'unpacked', path: dir, enabled: false, icon: null, options: null, error: 'Folder or manifest.json is missing', hasAction: false, pinned: false, siteAccess: null });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // One extension's details page.
  async details(key) {
    const item = this.list().find((x) => x.key === key);
    if (!item) return null;
    const manifest = readManifest(item.path) || {};
    const homepage = manifest.homepage_url || (item.type === 'store' ? `https://chromewebstore.google.com/detail/${item.id}` : null);
    return {
      ...item,
      permissions: access.describePermissions(manifest),
      limitations: access.limitations(manifest),
      access: {
        ...this.siteAccess(key),
        applies: access.wantsSites(manifest),
        // Unpacked extensions get the access their manifest asks for.
        changeable: item.type === 'store' && access.canRestrict(manifest),
      },
      fileAccess: this.fileAccess(key),
      size: await access.folderSize(item.path),
      commands: commands.commandsFor(manifest, (this.settings.extensionShortcuts || {})[item.id] || {}, PLATFORM),
      homepage: /^https:\/\//.test(homepage || '') ? homepage : null,
      // Electron can't run extensions in incognito's in-memory session.
      incognito: { available: false },
    };
  }

  // ---------------------------------------------------------------- toolbar pins
  pinned() { return Array.isArray(this.settings.pinnedExtensions) ? this.settings.pinnedExtensions : []; }
  setPinned(id, on) {
    if (!/^[a-p]{32}$/.test(String(id))) return;
    const list = this.pinned().filter((x) => x !== id);
    this.store.setSetting('pinnedExtensions', on ? [...list, id] : list);
    this.hooks.changed();
  }

  // The puzzle menu: every extension that's on, with what it can do here.
  menu(url) {
    return this.api.getAllExtensions().map((ext) => {
      const key = this.keyOf(ext);
      const src = this.sourceDir(key) || ext.path;
      const manifest = readManifest(src) || ext.manifest;
      const limits = this.siteAccess(key);
      let host = '';
      try { host = /^https?:$/.test(new URL(url).protocol) ? new URL(url).hostname : ''; } catch { /* not a site */ }
      return {
        id: ext.id,
        key,
        name: localize(src, manifest, manifest.name),
        icon: iconDataUrl(src, manifest),
        hasAction: !!(manifest.action || manifest.browser_action || manifest.page_action),
        pinned: this.pinned().includes(ext.id),
        // On this page: 'granted', 'withheld' or 'none'.
        here: access.accessOn(manifest, limits, url),
        access: limits.mode,
        host,
        siteListed: !!host && limits.sites.some((s) => access.covers(access.normalizeSite(s) || '', host)),
        changeable: !this.isUnpacked(key) && access.canRestrict(manifest),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- site and file access
  async setSiteAccess(key, next = {}) {
    if (!access.ACCESS_MODES.includes(next.mode)) return false;
    const sites = [...new Set((next.sites || []).map(access.normalizeSite).filter(Boolean))].slice(0, 200);
    const all = { ...(this.settings.extensionAccess || {}) };
    if (next.mode === 'all') delete all[key]; else all[key] = { mode: next.mode, sites };
    this.store.setSetting('extensionAccess', all);
    if (this.loadedFor(key)) await this.reload(key);
    this.hooks.changed();
    return true;
  }

  // The puzzle menu's quick choices for the page you're on.
  async setAccessForSite(key, choice, host) {
    const cur = this.siteAccess(key);
    if (choice === 'site' && access.normalizeSite(host)) return this.setSiteAccess(key, { mode: 'sites', sites: [...cur.sites, host] });
    if (choice === 'click' || choice === 'all') return this.setSiteAccess(key, { mode: choice, sites: cur.sites });
    return false;
  }

  async setFileAccess(key, on) {
    const all = { ...(this.settings.extensionFileAccess || {}) };
    if (on) all[key] = true; else delete all[key];
    this.store.setSetting('extensionFileAccess', all);
    if (this.loadedFor(key)) await this.reload(key);
    this.hooks.changed();
  }

  // ---------------------------------------------------------------- on, off, remove
  async setEnabled(key, enabled) {
    const disabled = new Set(this.settings.disabledExtensions || []);
    if (enabled) {
      disabled.delete(key);
      this.store.setSetting('disabledExtensions', [...disabled]);
      if (!this.loadedFor(key)) {
        try { await this.load(key); } catch (err) { this.errors.set(key, err.message); }
      }
    } else {
      disabled.add(key);
      this.store.setSetting('disabledExtensions', [...disabled]);
      const ext = this.loadedFor(key);
      if (ext) this.api.removeExtension(ext.id);
    }
    this.hooks.changed();
    this.hooks.commandsChanged?.();
  }

  async remove(key) {
    const unpackedList = this.settings.unpackedExtensions || [];
    const id = this.loadedFor(key)?.id || (/^[a-p]{32}$/.test(key) ? key : null);
    if (unpackedList.includes(key)) {
      const ext = this.loadedFor(key);
      if (ext) this.api.removeExtension(ext.id);
      this.store.setSetting('unpackedExtensions', unpackedList.filter((p) => p !== key));
    } else if (/^[a-p]{32}$/.test(key)) {
      await uninstallExtension(key, { session: this.session, extensionsPath: this.root });
    }
    this.store.setSetting('disabledExtensions', (this.settings.disabledExtensions || []).filter((k) => k !== key));
    // Forget what was set for it.
    for (const name of ['extensionAccess', 'extensionFileAccess', 'extensionShortcuts']) {
      const all = { ...(this.settings[name] || {}) };
      if (key in all || (id && id in all)) { delete all[key]; if (id) delete all[id]; this.store.setSetting(name, all); }
    }
    if (id && this.pinned().includes(id)) this.store.setSetting('pinnedExtensions', this.pinned().filter((x) => x !== id));
    this.errors.delete(key);
    this.hooks.changed();
    this.hooks.commandsChanged?.();
  }

  async loadUnpacked(dir) {
    if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) return { ok: false, error: 'That folder has no manifest.json.' };
    const list = this.settings.unpackedExtensions || [];
    const known = list.includes(dir);
    if (!known) this.store.setSetting('unpackedExtensions', [...list, dir]);
    try {
      const old = this.loadedFor(dir);
      if (old) this.api.removeExtension(old.id);
      const ext = await this.load(dir);
      this.hooks.changed();
      this.hooks.commandsChanged?.();
      return { ok: true, id: ext.id };
    } catch (err) {
      if (!known) this.store.setSetting('unpackedExtensions', list);
      return { ok: false, error: err.message };
    }
  }

  async reload(key) {
    const ext = this.loadedFor(key);
    if (ext) this.api.removeExtension(ext.id);
    await this.setEnabled(key, true);
  }

  // Developer mode › Update: reload every unpacked extension and check the
  // Web Store for new versions now.
  async updateAll() {
    const disabled = new Set(this.settings.disabledExtensions || []);
    for (const dir of this.settings.unpackedExtensions || []) if (!disabled.has(dir)) await this.reload(dir).catch(() => {});
    if (!process.env.LUMIO_TEST) await updateExtensions(this.session).catch(() => {});
    this.hooks.changed();
    return { ok: true };
  }

  pack(dir, keyFile) { return packExtension(dir, keyFile); }

  // ---------------------------------------------------------------- keyboard shortcuts
  // Extensions with commands, for lumio://extensions/shortcuts. The menu
  // asks often and has no use for the icons.
  shortcuts({ icons = true } = {}) {
    const all = this.settings.extensionShortcuts || {};
    const list = this.api.getAllExtensions().map((ext) => {
      const src = this.sourceDir(this.keyOf(ext)) || ext.path;
      const manifest = readManifest(src) || ext.manifest;
      const saved = all[ext.id] || {};
      return {
        id: ext.id,
        name: localize(src, manifest, manifest.name),
        icon: icons ? iconDataUrl(src, manifest) : null,
        commands: commands.commandsFor(manifest, saved, PLATFORM)
          .map((c) => ({ ...c, description: localize(src, manifest, c.description), suggestion: !Object.hasOwn(saved, c.name) })),
      };
    });
    // Like Chrome, a key an extension only suggests is dropped ("Not set")
    // when Lumio or another extension already uses it. Keys the person set
    // were checked then, so they come first.
    const key = (s) => commands.canonical(commands.toAccelerator(s, PLATFORM), PLATFORM);
    const taken = new Set(this.reservedKeys());
    for (const x of list) for (const c of x.commands) if (!c.suggestion && c.shortcut) taken.add(key(c.shortcut));
    for (const x of list) {
      for (const c of x.commands) {
        if (c.suggestion && c.shortcut) {
          if (taken.has(key(c.shortcut))) c.shortcut = ''; else taken.add(key(c.shortcut));
        }
        c.label = commands.label(c.shortcut, PLATFORM);
        delete c.suggestion;
      }
    }
    return list.filter((x) => x.commands.length).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Every shortcut in use by an extension: [{ id, name, shortcut, accelerator }].
  activeShortcuts() {
    return this.shortcuts({ icons: false }).flatMap((x) => x.commands.filter((c) => c.shortcut).map((c) => ({
      id: x.id, name: c.name, shortcut: c.shortcut, accelerator: commands.toAccelerator(c.shortcut, PLATFORM),
    })));
  }

  // reserved: canonical accelerators Lumio's own menu uses.
  setShortcut(id, name, shortcut, reserved = new Set()) {
    const ext = this.api.getExtension(String(id));
    if (!ext || !Object.hasOwn(ext.manifest?.commands || {}, name)) return { ok: false, error: 'That extension isn’t on.' };
    const value = String(shortcut || '');
    if (value) {
      const error = commands.validate(value, PLATFORM);
      if (error) return { ok: false, error };
      const mine = commands.canonical(commands.toAccelerator(value, PLATFORM), PLATFORM);
      if (reserved.has(mine)) return { ok: false, error: 'Lumio already uses that shortcut.' };
      const clash = this.activeShortcuts().find((s) => !(s.id === ext.id && s.name === name) && commands.canonical(s.accelerator, PLATFORM) === mine);
      if (clash) return { ok: false, error: `${this.shortcuts({ icons: false }).find((x) => x.id === clash.id)?.name || 'Another extension'} already uses it.` };
    }
    const all = { ...(this.settings.extensionShortcuts || {}) };
    all[ext.id] = { ...(all[ext.id] || {}), [name]: value };
    this.store.setSetting('extensionShortcuts', all);
    this.syncCommandLabels(ext.id);
    this.hooks.commandsChanged?.();
    return { ok: true, label: commands.label(value, PLATFORM) };
  }

  // chrome.commands.getAll() reports the real shortcuts (the library always says none).
  syncCommandLabels(id) {
    const list = this.ece?.api?.commands?.commandMap?.get(id);
    if (!list) return;
    const now = this.shortcuts({ icons: false }).find((x) => x.id === id)?.commands || [];
    for (const c of list) c.shortcut = now.find((x) => x.name === c.name)?.label || '';
  }

  // A shortcut was pressed: the toolbar button for _execute_action, else
  // chrome.commands.onCommand in the extension.
  runCommand(id, name, wc) {
    if (commands.ACTION_COMMANDS.has(name)) { this.hooks.activate?.(id); return; }
    try {
      const tab = wc && !wc.isDestroyed() ? this.ece.api.tabs.getTabDetails(wc) : undefined;
      this.ece.ctx.router.sendEvent(id, 'commands.onCommand', name, tab);
    } catch { /* the extension isn't listening */ }
  }

  // ---------------------------------------------------------------- new tab page
  // An extension that replaces the new tab page (chrome_url_overrides.newtab);
  // the newest one wins, like in Chrome.
  newTabOverride() {
    for (const ext of this.api.getAllExtensions().slice().reverse()) {
      const page = ext.manifest?.chrome_url_overrides?.newtab;
      if (typeof page !== 'string') continue;
      const rel = page.replace(/^\//, '');
      if (!fs.existsSync(path.join(ext.path, rel))) continue;
      const src = this.sourceDir(this.keyOf(ext)) || ext.path;
      return { id: ext.id, key: this.keyOf(ext), name: localize(src, ext.manifest, ext.manifest.name), url: `chrome-extension://${ext.id}/${rel}` };
    }
    return null;
  }

  // Tab bookkeeping for chrome.tabs.
  addTab(wc, win) { try { this.ece?.addTab(wc, win); } catch { /* other session */ } }
  removeTab(wc) { try { this.ece?.removeTab(wc); } catch { /* not tracked */ } }
  selectTab(wc) { try { this.ece?.selectTab(wc); } catch { /* not tracked */ } }
  contextMenuItems(wc, params) {
    try { return this.ece ? this.ece.getContextMenuItems(wc, params) : []; } catch { return []; }
  }
}

module.exports = { ExtensionManager, WEBSTORE_ORIGIN, compareVersions };
