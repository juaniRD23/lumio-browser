// Installed web apps (Share › Install page as app… / Create shortcut…).
// An app is a site that opens in its own window: no tab strip, a slim title
// bar with back and reload, its own icon and its own menu. Lumio reads the
// site's web app manifest (name, start page, scope, icons) when it has one,
// and otherwise uses the page's title and icon. On the Mac each app also gets
// a launcher (main/app-launchers.js): an app in ~/Applications/Lumio Apps
// that can go in the Dock. lumio://apps lists them, with Open and Remove.
//
// App windows use the normal profile's session, so you're signed in to the
// site there like in your tabs. Links to other sites open in a Lumio tab.
// On the Mac the window shows Lumio's own Dock icon (the launcher's icon is
// the one in Finder and the Dock while it's kept there).
//
// The site in an app window gets what it would in a tab of its profile: its
// saved passwords and "Save password?", passkeys (with the same Touch ID
// check), addresses, cards and earlier form entries, and the page's
// alert(), confirm() and prompt() as Lumio's card over the page. The window
// does that with the browser's own code: a one-page stand-in for the tabs
// (AppTabs), Lumio's dropdowns on its own overlay (main/overlay-host.js) and
// the dialog view (main/dialog-view.js). main.js finds it with holderOf()
// (the site) and uiOwner() (its title bar, dropdowns and dialog), and only
// for the calls in UI_CHANNELS, so nothing else of the browser's reaches it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell, WebContentsView } = require('electron');
const { JsonFile } = require('./store');
const theme = require('./theme');
const FLAVOR = require('./flavor');
const launchers = require('./app-launchers');

const { DialogView } = require('./dialog-view');
const { lendOverlay, wireOverlay } = require('./overlay-host');

const WORLD = 1005; // page tools' isolated world (see main/page-menu.js)
const SHELL_PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');
const INTERNAL_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const HEADER = 38; // the title bar's height
const MAC = process.platform === 'darwin';
const MAX_ICON = 3 * 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;
// What an app window's title bar, dropdowns and dialog may ask main.js for
// (the rest of the browser's calls are for browser windows only).
const UI_CHANNELS = new Set([
  'overlay:show', 'overlay:hide', 'overlay:size', 'overlay:pick',
  'passwords:fill', 'passwords:decide', 'passwords:passkey', 'passwords:reveal-pending', 'passwords:manage',
  'autofill:pick', 'autofill:remove', 'autofill:manage', 'autofill:decide',
]);
const web = (url) => /^https?:/i.test(url || '');
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
// This computer or the local network: a public page's manifest and icons are never fetched from there.
function isLocal(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '0.0.0.0' || /^(127|10)\./.test(h)
    || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

// Runs in the page: where its manifest is, the icons it lists and its names.
function pageAppInfo() {
  const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')]
    .map((l) => ({ src: l.href, sizes: l.getAttribute('sizes') || '', type: l.type || '', touch: /apple/.test(l.rel) }));
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
  return { manifest: document.querySelector('link[rel~="manifest"]')?.href || null, icons, name: meta('application-name') || meta('apple-mobile-web-app-title'), title: document.title };
}

const sizeOf = (s) => Math.max(0, ...String(s || '').split(/\s+/).map((x) => Number(x.split(/x/i)[0]) || 0));

// The app's name, start page, scope and icons to try, from the manifest when
// the site has a usable one (it must be on the page's own origin).
function appDetails(pageUrl, page = {}, manifest = null, manifestUrl = null) {
  const origin = new URL(pageUrl).origin;
  const same = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };
  const resolve = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };
  let startUrl = pageUrl;
  let scope = `${origin}/`;
  let name = page.name || page.title || hostOf(pageUrl);
  const icons = [];
  if (manifest && typeof manifest === 'object' && manifestUrl) {
    const start = typeof manifest.start_url === 'string' ? resolve(manifest.start_url, manifestUrl) : null;
    if (start && same(start)) startUrl = start;
    const sc = typeof manifest.scope === 'string' ? resolve(manifest.scope, manifestUrl) : null;
    if (sc && same(sc) && startUrl.startsWith(sc)) scope = sc;
    const n = [manifest.name, manifest.short_name].find((x) => typeof x === 'string' && x.trim());
    if (n) name = n;
    for (const i of Array.isArray(manifest.icons) ? manifest.icons : []) {
      if (!i || typeof i.src !== 'string') continue;
      const purpose = String(i.purpose || 'any');
      if (!/\bany\b/.test(purpose)) continue; // maskable icons are cropped by the system; not for a plain launcher
      if (/svg/i.test(i.type || '') || /\.svg(\?|$)/i.test(i.src)) continue; // can't draw SVG here
      const src = resolve(i.src, manifestUrl);
      if (src && /^(https?|data):/i.test(src)) icons.push({ src, size: sizeOf(i.sizes) || 192 });
    }
  }
  for (const i of page.icons || []) {
    if (/svg/i.test(i.type || '') || /\.(svg|ico)(\?|$)/i.test(i.src || '')) continue;
    if (/^(https?|data):/i.test(i.src || '')) icons.push({ src: i.src, size: sizeOf(i.sizes) || (i.touch ? 180 : 32) });
  }
  icons.push({ src: `${origin}/apple-touch-icon.png`, size: 180 }); // where many sites keep one
  icons.sort((a, b) => b.size - a.size);
  return { startUrl, scope, name: String(name).trim().slice(0, 60) || hostOf(pageUrl), icons: icons.filter((x, i) => icons.findIndex((y) => y.src === x.src) === i).slice(0, 8) };
}

class Apps {
  // Each app belongs to the profile it was installed from (rec.profile;
  // apps from before profiles have none: the first profile).
  // session(profile): that profile's session. permissions(profile): its site
  // permissions (main/features.js). profile(id): the whole profile (its
  // passwords, autofill and store; tests may leave it out). openUrl(url, profile): a new tab in one
  // of its normal windows. cmd: the browser's menu commands. restoreMenu(): the browser's
  // menu again (when an app window loses focus on the Mac). launcherDir: where
  // the Mac launchers go.
  constructor({ dir, session, permissions, profile = () => null, openUrl, cmd = {}, restoreMenu = () => {}, toast = () => {}, launcherDir = path.join(os.homedir(), 'Applications', `${FLAVOR.beta ? 'Lumio Beta' : 'Lumio'} Apps`) }) {
    this.dir = path.join(dir, 'apps');
    this.launcherDir = launcherDir;
    this.file = new JsonFile(dir, 'apps.json', { apps: [] });
    this.session = session;
    this.permissions = permissions;
    this.profile = profile;
    this.openUrl = openUrl;
    this.cmd = cmd;
    this.restoreMenu = restoreMenu;
    this.toast = toast;
    this.windows = new Set(); // open AppWindows
    this.prompts = new Map(); // token -> an Install / Create shortcut dialog waiting for an answer
  }

  list() { return Array.isArray(this.file.data.apps) ? this.file.data.apps : []; }
  get(id) { return this.list().find((a) => a.id === id) || null; }
  iconFile(id, ext = 'png') { return path.join(this.dir, id, `icon.${ext}`); }

  // ---------------------------------------------------------------- installing
  async fetchBytes(url, max, profile) {
    if (/^data:image\//i.test(url)) {
      const m = /^data:[^;,]+(;base64)?,(.*)$/is.exec(url);
      return m ? (m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]))) : null;
    }
    const res = await this.session(profile).fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok || Number(res.headers.get('content-length') || 0) > max || !res.body) return null;
    // Read with a cap: a server that doesn't say the size can't fill memory.
    const reader = res.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
    return Buffer.concat(parts);
  }

  // The first icon that decodes and is big enough, as a 256-pixel PNG.
  async pickIcon(candidates, favicon, profile) {
    let small = null;
    for (const c of [...candidates, ...(favicon ? [{ src: favicon, size: 16 }] : [])]) {
      let img = null;
      try { const buf = await this.fetchBytes(c.src, MAX_ICON, profile); img = buf ? nativeImage.createFromBuffer(buf) : null; } catch { /* try the next one */ }
      if (!img || img.isEmpty()) continue;
      const { width, height } = img.getSize();
      if (Math.min(width, height) >= 96) return img.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
      if (Math.min(width, height) >= 32 && !small) small = img;
    }
    return small ? small.resize({ width: 256, height: 256, quality: 'best' }).toPNG() : null;
  }

  async prepare(tab, { shortcut = false, profile } = {}) {
    const wc = tab.view?.webContents;
    const pageUrl = wc?.getURL() || '';
    if (!wc || !web(pageUrl)) return null;
    const page = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${pageAppInfo})()` }]).catch(() => ({}));
    const reachable = (u) => !isLocal(u) || isLocal(pageUrl);
    let manifest = null;
    if (page?.manifest && web(page.manifest) && reachable(page.manifest)) {
      try {
        const buf = await this.fetchBytes(page.manifest, MAX_MANIFEST, profile);
        manifest = buf ? JSON.parse(buf.toString('utf8')) : null;
      } catch { /* no usable manifest */ }
    }
    const d = appDetails(pageUrl, page || {}, manifest, page?.manifest);
    // Create shortcut opens the page you're on; Install opens the app's start page.
    if (shortcut) { d.startUrl = pageUrl; d.name = String(page?.title || d.name).trim().slice(0, 60) || d.name; }
    return { ...d, host: hostOf(pageUrl), iconPng: await this.pickIcon(d.icons.filter((i) => reachable(i.src)), reachable(tab.favicon || '') ? tab.favicon : null, profile) };
  }

  // Shows the Install app / Create shortcut dialog over the page.
  async prompt(w, tab, { shortcut = false } = {}) {
    if (w.incognito || w.profile?.guest) { this.toast(w, w.incognito ? 'Apps can’t be installed from an incognito window' : 'Apps can’t be installed in Guest mode'); return; }
    const profile = w.profile?.base?.id;
    const info = await this.prepare(tab, { shortcut, profile }).catch(() => null);
    if (!info) { this.toast(w, 'Only web pages can be installed as apps'); return; }
    if (w.closed || w.tabs.active !== tab) return;
    const token = crypto.randomBytes(12).toString('hex');
    this.prompts.clear(); // one dialog at a time
    this.prompts.set(token, { w, tab, info, shortcut, profile });
    const b = tab.view.getBounds();
    const width = 380;
    w.showOverlay({ x: b.x + b.width - width - 24 - 8, y: b.y + 4, width: width + 24, height: 330 }, {
      kind: 'install', token, shortcut, name: info.name, host: info.host, platform: process.platform,
      icon: info.iconPng ? `data:image/png;base64,${info.iconPng.toString('base64')}` : null,
    });
    w.overlay.webContents.focus();
  }

  async install(w, { token, name, window: asWindow = true, iconPng } = {}) {
    const p = this.prompts.get(String(token || ''));
    if (!p || p.w !== w) return;
    this.prompts.delete(token);
    w.hideOverlay();
    w.emit('overlay-picked', { kind: 'install' });
    const clean = String(name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || p.info.name;
    let png = p.info.iconPng;
    if (!png && iconPng instanceof Uint8Array && iconPng.length < 2 * 1024 * 1024) {
      const img = nativeImage.createFromBuffer(Buffer.from(iconPng));
      if (!img.isEmpty()) png = img.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
    }
    const rec = {
      id: crypto.randomBytes(8).toString('hex'),
      name: clean,
      url: p.info.startUrl,
      scope: p.info.scope,
      window: p.shortcut ? !!asWindow : true,
      shortcut: !!p.shortcut,
      ...(p.profile ? { profile: p.profile } : {}),
      created: Date.now(),
      launchers: [],
    };
    try {
      fs.mkdirSync(path.join(this.dir, rec.id), { recursive: true });
      if (png) fs.writeFileSync(this.iconFile(rec.id), png);
    } catch { /* the app works without its icon file */ }
    rec.launchers = this.writeLaunchers(rec, png);
    this.file.data.apps = [...this.list(), rec];
    this.file.save(true);
    this.toast(w, p.shortcut ? `Shortcut “${clean}” created` : `${clean} installed`);
    if (rec.window) this.open(rec.id);
  }

  // The app's launcher in Finder and the Dock (the Mac only). Returns the
  // files made; a failure only costs the launcher.
  writeLaunchers(rec, png) {
    if (!MAC || !png) return [];
    try {
      const img = nativeImage.createFromBuffer(png);
      const sized = (n) => img.resize({ width: n, height: n, quality: 'best' }).toPNG();
      const icon = launchers.icns({ 128: sized(128), 256: sized(256), 512: sized(512) });
      const lumio = app.isPackaged ? { bundleId: FLAVOR.bundleId } : { appBundle: path.resolve(process.execPath, '../../..'), appPath: app.getAppPath() };
      return [launchers.writeMacBundle(this.launcherDir, { id: rec.id, name: rec.name, lumio, icon })];
    } catch (err) {
      console.error('[lumio] app launcher:', err?.message || err);
      return [];
    }
  }

  uninstall(id) {
    const rec = this.get(id);
    if (!rec) return false;
    for (const aw of [...this.windows]) if (aw.rec.id === id) aw.win.close();
    for (const file of rec.launchers || []) {
      // Only launchers Lumio made, in its own Apps folder.
      if (/\.app$/.test(file) && path.dirname(file) === this.launcherDir) fs.rmSync(file, { recursive: true, force: true });
    }
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.file.data.apps = this.list().filter((a) => a.id !== id);
    this.file.save(true);
    return true;
  }

  // ---------------------------------------------------------------- opening
  open(id) {
    const rec = this.get(id);
    if (!rec) return false;
    if (!rec.window) { this.openUrl(rec.url, rec.profile); return true; }
    const existing = [...this.windows].find((aw) => aw.rec.id === id);
    if (existing) { existing.focus(); return true; }
    this.windows.add(new AppWindow(this, rec));
    return true;
  }

  // Lumio started (or was asked again) by an app's launcher.
  launch(argv) {
    const id = launchers.appIdFromArgv(argv);
    return !!id && this.open(id);
  }

  saveBounds(rec, bounds) {
    const r = this.get(rec.id);
    if (!r) return;
    r.bounds = bounds;
    this.file.save(true); // the window closing may be Lumio quitting
  }

  // The focused app window's menu (the Mac shows one menu bar for all windows).
  focusedMenu() {
    const f = BrowserWindow.getFocusedWindow();
    return [...this.windows].find((aw) => aw.win === f)?.menu || null;
  }

  applyAppearance() { for (const aw of this.windows) aw.applyAppearance(); }

  // The app window showing a site's page (its Share buttons, main/share.js).
  windowFor(wc) { return [...this.windows].find((aw) => aw.view.webContents === wc) || null; }

  // The site's page as main.js's tab lookups give it: { w, tab }, where w is
  // its app window (its profile's passwords and autofill, its overlay).
  holderOf(wc) {
    const aw = wc && this.windowFor(wc);
    return aw && !aw.closed && aw.profile ? { w: aw, tab: aw.tab } : null;
  }

  // The app window whose own UI (title bar, overlay, dialog) sent a call,
  // for the calls an app window answers (UI_CHANNELS); null for any other.
  uiOwner(wc, channel = null) {
    if (!wc || (channel !== null && !UI_CHANNELS.has(channel))) return null;
    return [...this.windows].find((aw) => !aw.closed && aw.profile && (aw.win.webContents === wc || aw.overlay?.webContents === wc || aw.dialogs?.view?.webContents === wc)) || null;
  }

  // A site in an app window asked for a permission (camera, location…):
  // the browser windows can't show it, so the app window asks with a dialog.
  emitFor(wcId, channel, payload) {
    if (channel !== 'permission') return false;
    const aw = [...this.windows].find((x) => x.view.webContents.id === wcId);
    if (!aw) return false;
    dialog.showMessageBox(aw.win, {
      type: 'question', buttons: ['Allow', 'Block', 'Not now'], defaultId: 2, cancelId: 2,
      message: `${payload.host} wants to ${payload.label}`,
    }).then(({ response }) => this.permissions(aw.rec.profile).respond(payload.id, ['allow', 'block', 'dismiss'][response] || 'dismiss')).catch(() => {}); // Not now (or Esc) isn't remembered
    return true;
  }

  // ---------------------------------------------------------------- calls
  register({ on, internalHandle }) {
    on('apps:install', (w, payload) => { this.install(w, payload || {}).catch(() => {}); });
    // The app window's title bar (renderer/ui/app-window.js).
    const from = (e) => [...this.windows].find((aw) => aw.win.webContents === e.sender) || null;
    ipcMain.handle('apps:state', (e) => from(e)?.state() || null);
    ipcMain.on('apps:nav', (e, payload) => from(e)?.nav(payload || {}));
    // lumio://apps
    internalHandle('page:apps', ['apps'], () => this.list().map((a) => {
      let icon = null;
      try { icon = `data:image/png;base64,${fs.readFileSync(this.iconFile(a.id)).toString('base64')}`; } catch { /* no icon */ }
      return { id: a.id, name: a.name, url: a.url, host: hostOf(a.url), window: a.window, created: a.created, icon, launcher: !!a.launchers?.length };
    }));
    internalHandle('page:app-open', ['apps'], (_ctx, id) => this.open(String(id)));
    internalHandle('page:app-reveal', ['apps'], (_ctx, id) => { const f = this.get(String(id))?.launchers?.[0]; if (f) shell.showItemInFolder(f); return !!f; });
    internalHandle('page:app-remove', ['apps'], async ({ w }, id) => {
      const rec = this.get(String(id));
      if (!rec) return false;
      const { response } = await dialog.showMessageBox(w.win, {
        type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `Remove “${rec.name}”?`,
        detail: `${rec.launchers?.length ? 'Its app in Applications › Lumio Apps will be removed too. ' : ''}You stay signed in to ${hostOf(rec.url)} in Lumio.`,
      });
      return response === 0 && this.uninstall(rec.id);
    });
  }
}

// The app window's one page, shaped like main/tabs.js's TabManager for the
// code that works on a tab (passwords, autofill, passkeys, the page's
// dialogs). Its dialog queue is TabManager's own (ask, answer, dismiss).
class AppTabs {
  constructor(aw) {
    this.aw = aw;
    this.tab = { id: 1, view: aw.view, owner: this, dialogs: [] };
    this.tabs = [this.tab];
    this.activeId = 1;
    this.covered = false; // (the dialog view checks it: nothing covers an app's page)
  }

  get active() { return this.tab; }
  wc() { const wc = this.tab.view.webContents; return wc.isDestroyed() ? null : wc; }
  byWebContents(wc) { return wc && wc === this.tab.view.webContents ? this.tab : null; }
  dialogsChanged() { if (!this.aw.closed) this.aw.dialogs.sync(); }
}
let borrowed = false;
function borrowTabCode() {
  if (borrowed) return;
  borrowed = true;
  const { TabManager } = require('./tabs');
  for (const m of ['ask', 'answer', 'dismiss']) AppTabs.prototype[m] = TabManager.prototype[m];
  lendOverlay(AppWindow, require('./window').BrowserWin);
}

// One app's window: its title bar (renderer/ui/app-window.html) and the site under it.
class AppWindow {
  constructor(apps, rec) {
    borrowTabCode();
    this.apps = apps;
    this.rec = rec;
    // The profile it was installed from: its passwords, passkeys and autofill
    // (the same one whose session the site uses).
    this.profile = apps.profile(rec.profile) || null;
    this.incognito = false;
    this.indicator = { bar: null }; // no Lumio AI here
    this.app = { onPasskeyPromptClosed: (w) => w.profile?.passwords?.passkeyClosed(w) }; // what main/window.js's overlay code tells
    const c = theme.colors(theme.isDark(false), false);
    this.win = new BrowserWindow({
      ...this.bounds(),
      minWidth: 360,
      minHeight: 280,
      title: rec.name,
      show: false,
      backgroundColor: c.frame,
      ...(MAC
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 13, y: 12 } }
        : { titleBarStyle: 'hidden', titleBarOverlay: { color: c.frame, symbolColor: c.symbol, height: HEADER }, autoHideMenuBar: true, ...(fs.existsSync(apps.iconFile(rec.id)) ? { icon: apps.iconFile(rec.id) } : {}) }),
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.menu = this.buildMenu();
    this.icon = null; // the title bar's little icon
    try { const img = nativeImage.createFromPath(apps.iconFile(rec.id)); if (!img.isEmpty()) this.icon = img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL(); } catch { /* no icon */ }
    if (!MAC) { this.win.setMenu(this.menu); this.win.setMenuBarVisibility(false); }
    this.win.loadURL('lumio://overlay/app-window.html');

    this.view = new WebContentsView({
      webPreferences: { session: apps.session(rec.profile), sandbox: true, contextIsolation: true, nodeIntegration: false, preload: INTERNAL_PRELOAD, spellcheck: true, plugins: true },
    });
    this.view.setBackgroundColor('#ffffff');
    this.win.contentView.addChildView(this.view);
    this.tabs = new AppTabs(this);
    this.tab = this.tabs.active;
    // Lumio's dropdowns and bubbles over the site, and its dialogs.
    this.overlay = new WebContentsView({ webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.loadURL('lumio://overlay/');
    wireOverlay(this);
    this.dialogs = new DialogView(this);
    this.layout();
    this.wire();
    this.tab.navigatingTo = rec.url; // its first page may ask to sign in
    this.view.webContents.loadURL(rec.url).catch(() => {});

    this.win.once('ready-to-show', () => { if (!process.env.LUMIO_HIDDEN) this.win.show(); });
    this.win.on('resize', () => this.layout());
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => this.layout());
    // The Mac has one menu bar: this app's while its window is in front.
    this.win.on('focus', () => { if (MAC) Menu.setApplicationMenu(this.menu); });
    this.win.on('blur', () => { if (MAC) apps.restoreMenu(); });
    this.win.on('close', () => apps.saveBounds(rec, this.win.getBounds()));
    this.win.on('closed', () => {
      apps.windows.delete(this);
      apps.permissions(rec.profile)?.dropFor(this.wcId);
      // Whatever the page was waiting on is answered "no".
      this.tabs.dismiss(this.tab);
      this.profile?.passwords?.passkeyClosed(this);
      this.profile?.autofill?.closeAll(this);
      this.dialogs.destroy();
      if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.close();
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
      if (MAC) apps.restoreMenu();
    });
  }

  bounds() {
    const b = this.rec.bounds;
    if (b && screen.getAllDisplays().some((d) => { const a = d.workArea; return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 60; })) return b;
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(1100, wa.width - 80);
    const height = Math.min(780, wa.height - 60);
    return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
  }

  layout() {
    const [w, h] = this.win.getContentSize();
    const top = this.win.isFullScreen() ? 0 : HEADER;
    this.view.setBounds({ x: 0, y: top, width: w, height: Math.max(1, h - top) });
    this.dialogs?.place();
    // A dropdown under a field would be left where the field was.
    if (this.overlayKind === 'formfill') this.profile?.autofill?.closeAll(this);
    else if (this.overlayKind === 'autofill') this.hideOverlay({ now: true });
  }

  get closed() { return this.win.isDestroyed(); }

  // To its title bar (renderer/ui/app-window.js): "Save password?", toasts,
  // a dropdown that closed.
  emit(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  applyAppearance() {
    if (this.win.isDestroyed()) return;
    const c = theme.colors(theme.isDark(false), false);
    this.win.setBackgroundColor(c.frame);
    if (!MAC) this.win.setTitleBarOverlay({ color: c.frame, symbolColor: c.symbol });
  }

  inScope(url) { return String(url || '').startsWith(this.rec.scope); }

  state() {
    const wc = this.view.webContents;
    const url = wc.isDestroyed() ? '' : wc.getURL();
    return {
      name: this.rec.name,
      title: wc.isDestroyed() ? this.rec.name : wc.getTitle() || this.rec.name,
      url,
      host: hostOf(url),
      outside: !!url && !this.inScope(url) && web(url),
      secure: url.startsWith('https:'),
      canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
      canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
      loading: !wc.isDestroyed() && wc.isLoading(),
      icon: this.icon,
      platform: process.platform,
    };
  }

  push() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.win.isDestroyed()) return;
      const s = this.state();
      this.win.setTitle(s.title === s.name ? s.name : `${s.name} – ${s.title}`);
      this.win.webContents.send('app-state', s);
    }, 30);
  }

  wire() {
    const wc = this.view.webContents;
    this.wcId = wc.id;
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(ev, () => this.push());
    // A page that leaves takes its alert(), confirm() or prompt() with it.
    wc.on('did-start-navigation', (d) => {
      if (!d?.isMainFrame || d.isSameDocument) return;
      this.tab.navigatingTo = d.url; // whose sign-in requests may ask (main/page-dialogs.js)
      this.tabs.dismiss(this.tab, ['js', 'auth']);
    });
    wc.on('render-process-gone', () => this.tabs.dismiss(this.tab, ['js']));
    // Lumio's own pages are never opened from a site.
    wc.on('will-navigate', (e) => { if (/^lumio:/i.test(e.url || '')) e.preventDefault(); });
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame && /^lumio:/i.test(e.url || '')) e.preventDefault(); });
    // Popups with a size (sign-in, payments) stay popups; other new windows are Lumio tabs.
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (!web(url)) return { action: 'deny' };
      if (disposition === 'new-window' && features) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true } };
      this.apps.openUrl(url, this.rec.profile);
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => this.contextMenu(params));
    wc.on('zoom-changed', (_e, dir) => this.zoom(dir === 'in' ? 1 : -1));
  }

  zoom(step) {
    const wc = this.view.webContents;
    wc.setZoomLevel(step === 0 ? 0 : Math.max(-4, Math.min(5, wc.getZoomLevel() + step * 0.5)));
  }

  // The title bar's buttons.
  nav({ action, x, y }) {
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
    else if (action === 'home') wc.loadURL(this.rec.url).catch(() => {});
    else if (action === 'browser') this.toBrowser();
    else if (action === 'menu') this.pageMenu().popup({ window: this.win, ...(Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {}) });
  }

  // Open in Lumio Browser: the page moves to a tab and the app window closes.
  toBrowser() {
    const url = this.view.webContents.getURL();
    if (web(url)) this.apps.openUrl(url, this.rec.profile);
    this.win.close();
  }

  pageMenu() {
    const wc = this.view.webContents;
    return Menu.buildFromTemplate([
      { label: 'Copy Link', click: () => clipboard.writeText(wc.getURL()) },
      { label: `Open in ${FLAVOR.name}`, click: () => this.toBrowser() },
      { type: 'separator' },
      { label: 'Zoom In', click: () => this.zoom(1) },
      { label: 'Zoom Out', click: () => this.zoom(-1) },
      { label: 'Actual Size', click: () => this.zoom(0) },
      { type: 'separator' },
      { label: 'Print…', click: () => wc.print() },
      { type: 'separator' },
      { label: 'Installed Apps', click: () => this.apps.cmd.apps?.() },
      { label: `Remove ${this.rec.name}…`, click: () => this.removeAsk() },
    ]);
  }

  async removeAsk() {
    const { response } = await dialog.showMessageBox(this.win, { type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1, message: `Remove “${this.rec.name}”?` });
    if (response === 0) this.apps.uninstall(this.rec.id);
  }

  contextMenu(params) {
    const wc = this.view.webContents;
    const items = [];
    const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
    if (params.misspelledWord) {
      for (const word of (params.dictionarySuggestions || []).slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
      sep();
    }
    if (params.linkURL) {
      items.push(
        { label: `Open Link in ${FLAVOR.name}`, enabled: web(params.linkURL), click: () => this.apps.openUrl(params.linkURL, this.rec.profile) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      );
      sep();
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      );
      sep();
    }
    if (params.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      sep();
    } else if ((params.selectionText || '').trim()) {
      items.push({ role: 'copy' });
      sep();
    }
    if (!params.linkURL && !params.isEditable && params.mediaType === 'none' && !(params.selectionText || '').trim()) {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
      );
      sep();
    }
    items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // The app's own menu: on the Mac it replaces Lumio's while the window is
  // in front, so ⌘W, ⌘R and the rest act on this window, not a browser tab.
  buildMenu() {
    const wc = () => this.view.webContents;
    const cmd = this.apps.cmd;
    return Menu.buildFromTemplate([
      ...(MAC ? [{
        label: FLAVOR.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Cmd+,', click: () => cmd.settings?.() },
          { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => cmd.newWindow?.() },
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => cmd.newTab?.() },
          { type: 'separator' },
          { label: `Open in ${FLAVOR.name}`, click: () => this.toBrowser() },
          { label: 'Copy Link', accelerator: 'CmdOrCtrl+Shift+C', click: () => clipboard.writeText(wc().getURL()) },
          { type: 'separator' },
          { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => wc().print() },
          { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: () => this.win.close() },
          ...(MAC ? [] : [{ label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => this.win.close(), visible: false, acceleratorWorksWhenHidden: true }]),
        ],
      },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }] },
      {
        label: 'View',
        submenu: [
          { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => wc().reload() },
          { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => wc().reloadIgnoringCache() },
          ...(MAC ? [] : [{ label: 'Reload', accelerator: 'F5', click: () => wc().reload(), visible: false, acceleratorWorksWhenHidden: true }]),
          { type: 'separator' },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => this.zoom(1) },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => this.zoom(1), visible: false, acceleratorWorksWhenHidden: true },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => this.zoom(-1) },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => this.zoom(0) },
          { type: 'separator' },
          { label: 'Developer Tools', accelerator: MAC ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', click: () => wc().openDevTools({ mode: 'detach' }) },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'History',
        submenu: [
          { label: 'Back', accelerator: MAC ? 'Cmd+[' : 'Alt+Left', click: () => this.nav({ action: 'back' }) },
          { label: 'Forward', accelerator: MAC ? 'Cmd+]' : 'Alt+Right', click: () => this.nav({ action: 'forward' }) },
          { label: 'Home Page', accelerator: MAC ? 'Cmd+Shift+H' : 'Alt+Home', click: () => this.nav({ action: 'home' }) },
        ],
      },
      { label: 'Window', submenu: MAC ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [{ role: 'minimize' }, { role: 'close' }] },
    ]);
  }
}

module.exports = { Apps, AppWindow, AppTabs, UI_CHANNELS, appDetails, pageAppInfo, isLocal };
