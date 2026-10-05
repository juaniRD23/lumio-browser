// Chrome extensions for normal (non-incognito) windows.
//  - electron-chrome-extensions (GPL-3.0) provides chrome.tabs/windows/action,
//    toolbar buttons and popups on top of Electron's built-in support.
//  - electron-chrome-web-store lets chromewebstore.google.com install and
//    update extensions. Every install asks the user first.
// Disabled extensions stay on disk but aren't loaded. Unpacked extensions
// ("Load unpacked" in developer mode) are remembered by path in settings.
const { app, session: electronSession, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');

const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com';
// Installs are loaded one by one (not with loadAllExtensions) so disabled ones never start.
const findInstall = (() => {
  // findExtensionInstall isn't exported from the package root; reimplement the
  // small part we need: the newest version folder under Extensions/<id>/.
  const newest = (dir) => {
    let best = null;
    for (const name of fs.readdirSync(dir)) {
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

class ExtensionManager {
  // dir: the profile's folder (its installs go in dir/Extensions).
  constructor({ session, store, hooks, dir = app.getPath('userData') }) {
    this.session = session;
    this.store = store;
    this.hooks = hooks; // createTab, selectTab, removeTab, createWindow, removeWindow, changed
    this.root = path.join(dir, 'Extensions');
    this.ece = null;
    this.errors = new Map(); // id or path -> last load error
  }

  get api() { return this.session.extensions; }

  async init() {
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

    await installChromeWebStore({
      session: this.session,
      extensionsPath: this.root,
      loadExtensions: false,
      autoUpdate: !process.env.LUMIO_TEST,
      beforeInstall: (details) => this.confirmInstall(details),
    });

    this.api.on('extension-loaded', () => this.hooks.changed());
    this.api.on('extension-unloaded', () => this.hooks.changed());
    await this.loadAll();
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

  async loadAll() {
    const disabled = new Set(this.store.settings.disabledExtensions || []);
    let ids = [];
    try { ids = fs.readdirSync(this.root).filter((n) => /^[a-p]{32}$/.test(n)); } catch { /* none yet */ }
    for (const id of ids) {
      if (disabled.has(id) || this.api.getExtension(id)) continue;
      const found = findInstall(id, this.root);
      if (!found) continue;
      try { await this.startWorker(await this.api.loadExtension(found.path)); } catch (err) { this.errors.set(id, err.message); }
    }
    for (const dir of this.store.settings.unpackedExtensions || []) {
      if (disabled.has(dir)) continue;
      try { await this.startWorker(await this.api.loadExtension(dir)); } catch (err) { this.errors.set(dir, err.message); }
    }
  }

  async confirmInstall(details) {
    // The library only checks that the page's origin *starts with* the store's.
    if (details.frame?.origin !== WEBSTORE_ORIGIN) return { action: 'deny' };
    const m = details.manifest || {};
    const perms = [...(m.permissions || []), ...(m.host_permissions || [])]
      .filter((p) => typeof p === 'string')
      .map((p) => (p === '<all_urls>' || p === '*://*/*' || p === 'http://*/*' || p === 'https://*/*' ? 'Read and change all your data on all websites' : p));
    const unique = [...new Set(perms)].slice(0, 12);
    const win = details.browserWindow || BrowserWindow.getFocusedWindow();
    const opts = {
      type: 'question',
      buttons: ['Add extension', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Add “${details.localizedName}” to Lumio Browser?`,
      detail: unique.length ? `It can:\n• ${unique.join('\n• ')}` : 'It doesn’t ask for any special permissions.',
      icon: details.icon && !details.icon.isEmpty() ? details.icon : undefined,
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return { action: response === 0 ? 'allow' : 'deny' };
  }

  // Everything the extensions page shows: loaded, disabled and unpacked.
  list() {
    const disabled = new Set(this.store.settings.disabledExtensions || []);
    const out = [];
    const add = (id, extPath, manifest, { enabled, type }) => {
      out.push({
        id,
        key: type === 'unpacked' ? extPath : id,
        name: localize(extPath, manifest, manifest.name),
        description: localize(extPath, manifest, manifest.description),
        version: manifest.version,
        type,
        path: extPath,
        enabled,
        icon: iconDataUrl(extPath, manifest),
        options: manifest.options_page || manifest.options_ui?.page || null,
        error: this.errors.get(type === 'unpacked' ? extPath : id) || null,
      });
    };
    const loaded = new Map(this.api.getAllExtensions().map((e) => [e.id, e]));
    let ids = [];
    try { ids = fs.readdirSync(this.root).filter((n) => /^[a-p]{32}$/.test(n)); } catch { /* none */ }
    for (const id of ids) {
      const ext = loaded.get(id);
      if (ext) { add(id, ext.path, ext.manifest, { enabled: true, type: 'store' }); loaded.delete(id); continue; }
      const found = findInstall(id, this.root);
      if (found) add(id, found.path, found.manifest, { enabled: !disabled.has(id), type: 'store' });
    }
    for (const dir of this.store.settings.unpackedExtensions || []) {
      const ext = [...loaded.values()].find((e) => e.path === dir);
      if (ext) { add(ext.id, dir, ext.manifest, { enabled: true, type: 'unpacked' }); loaded.delete(ext.id); continue; }
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        add(null, dir, manifest, { enabled: false, type: 'unpacked' });
      } catch {
        out.push({ id: null, key: dir, name: path.basename(dir), description: '', version: '', type: 'unpacked', path: dir, enabled: false, icon: null, options: null, error: 'Folder or manifest.json is missing' });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async setEnabled(key, enabled) {
    const disabled = new Set(this.store.settings.disabledExtensions || []);
    const unpacked = (this.store.settings.unpackedExtensions || []).includes(key);
    if (enabled) {
      disabled.delete(key);
      this.store.setSetting('disabledExtensions', [...disabled]);
      const dir = unpacked ? key : findInstall(key, this.root)?.path;
      if (dir) {
        try {
          await this.startWorker(await this.api.loadExtension(dir));
          this.errors.delete(key);
        } catch (err) { this.errors.set(key, err.message); }
      }
    } else {
      disabled.add(key);
      this.store.setSetting('disabledExtensions', [...disabled]);
      const ext = unpacked ? this.api.getAllExtensions().find((e) => e.path === key) : this.api.getExtension(key);
      if (ext) this.api.removeExtension(ext.id);
    }
    this.hooks.changed();
  }

  async remove(key) {
    const unpackedList = this.store.settings.unpackedExtensions || [];
    if (unpackedList.includes(key)) {
      const ext = this.api.getAllExtensions().find((e) => e.path === key);
      if (ext) this.api.removeExtension(ext.id);
      this.store.setSetting('unpackedExtensions', unpackedList.filter((p) => p !== key));
    } else if (/^[a-p]{32}$/.test(key)) {
      await uninstallExtension(key, { session: this.session, extensionsPath: this.root });
    }
    this.store.setSetting('disabledExtensions', (this.store.settings.disabledExtensions || []).filter((k) => k !== key));
    this.errors.delete(key);
    this.hooks.changed();
  }

  async loadUnpacked(dir) {
    if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) return { ok: false, error: 'That folder has no manifest.json.' };
    try {
      const ext = await this.api.loadExtension(dir);
      await this.startWorker(ext);
      const list = this.store.settings.unpackedExtensions || [];
      if (!list.includes(dir)) this.store.setSetting('unpackedExtensions', [...list, dir]);
      this.hooks.changed();
      return { ok: true, id: ext.id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async reload(key) {
    const unpacked = (this.store.settings.unpackedExtensions || []).includes(key);
    const ext = unpacked ? this.api.getAllExtensions().find((e) => e.path === key) : this.api.getExtension(key);
    if (ext) this.api.removeExtension(ext.id);
    await this.setEnabled(key, true);
  }

  // Tab bookkeeping for chrome.tabs.
  addTab(wc, win) { try { this.ece?.addTab(wc, win); } catch { /* other session */ } }
  removeTab(wc) { try { this.ece?.removeTab(wc); } catch { /* not tracked */ } }
  selectTab(wc) { try { this.ece?.selectTab(wc); } catch { /* not tracked */ } }
  contextMenuItems(wc, params) {
    try { return this.ece ? this.ece.getContextMenuItems(wc, params) : []; } catch { return []; }
  }
}

module.exports = { ExtensionManager, WEBSTORE_ORIGIN };
