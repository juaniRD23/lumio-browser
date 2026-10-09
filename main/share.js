// Share: the address bar's Share button and the menus' Save and share items.
// Copy link; a QR code made on this computer (renderer/assets/qr.js, nothing
// is sent anywhere); Send to your devices (another computer signed in to
// Lumio Sync gets a "Tab from …" notification, through the companion relay,
// encrypted with the account's sync key, see docs/sync-managed.md);
// Screenshot (main/screenshot.js); Save page as; Install page as app / Create
// shortcut (main/apps.js); and on the Mac the system's share sheet. The
// popover itself is renderer/ui/overlay-share.js.
//
// Websites' Share buttons (navigator.share) open the same popover: a small
// shim in the page's own world (preload/internal.js) asks main through the
// tab's preload. Lumio checks the request itself (the page's top frame, the
// tab you're looking at, an http(s) link) and the page only learns whether
// it was shared or canceled. Sharing files isn't supported: canShare({ files })
// says no, so sites fall back to sharing a link. The shim is installed by the
// preload before the page's scripts run (not at dom-ready), so sites that
// check for navigator.share while loading find it. Frames inside a page
// don't get it, and in an installed app's window it opens the Mac's share
// sheet instead of the popover.
const fs = require('fs');
const path = require('path');
const { app, clipboard, dialog, ipcMain, nativeImage, Notification, ShareMenu } = require('electron');

const WORLD = 1005; // page tools' isolated world (see main/page-menu.js)
const DEVICES_FRESH = 2 * 60_000;
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
const web = (url) => /^https?:/i.test(url || '');
const POPOVERS = new Set(['share', 'media', 'install']); // page tools' popovers: clicking the page closes them

// What a website asked to share, checked again here: some text, and only
// http(s) links (relative ones are resolved against the page).
function cleanShareData(data, base) {
  if (!data || typeof data !== 'object') return null;
  const title = typeof data.title === 'string' ? data.title.slice(0, 300) : '';
  const text = typeof data.text === 'string' ? data.text.slice(0, 2000) : '';
  let url = '';
  if (typeof data.url === 'string' && data.url) {
    try { url = new URL(data.url, base).href; } catch { return null; }
    if (!web(url) || url.length > 4096) return null;
  }
  if (!title && !text && !url) return null;
  return { title, text, url };
}

class ShareTools {
  // sync / companion: Lumio Sync and its relay (main/sync). savePage(w, tab),
  // openUrl(url): a new tab in a normal window. screenshots and apps: the
  // other page tools. tabOfWc(wc): { w, tab } for a tab's page; windowOf(tab):
  // the window a tab is in (tabs can move between windows).
  // syncOf/companionOf(w): the window's profile's Lumio Sync and companion
  // link (each profile is a device of its own); sync/companion: one for all.
  constructor({ sync, companion, syncOf = () => sync, companionOf = () => companion, savePage, openUrl, screenshots, apps, tabOfWc, windowOf, now = () => Date.now(), openWait = 3000 }) {
    this.syncOf = syncOf;
    this.companionOf = companionOf;
    this.savePage = savePage;
    this.openUrl = openUrl;
    this.screenshots = screenshots;
    this.apps = apps;
    this.tabOfWc = tabOfWc;
    this.windowOf = windowOf;
    this.now = now;
    this.openWait = openWait; // how long a website's share waits for the popover to show
    this.caches = new WeakMap(); // sync -> { at, list } the person's other computers
    this.anchors = new WeakMap(); // window -> where the Share button is (for the Mac share sheet)
    this.pending = new WeakMap(); // window -> a website's share waiting for the person { tabId, data, resolve }
    this.notices = []; // "Tab from …" notifications (kept, or a click on them is lost)
    this.wired = new WeakSet();
  }

  // Clicking the page closes the page tools' popovers, like clicking anywhere else.
  wire(tab) {
    const wc = tab.view?.webContents;
    if (!wc || this.wired.has(wc)) return;
    this.wired.add(wc);
    wc.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type !== 'mouseDown') return;
      const w = this.windowOf(tab);
      const kind = w?.overlayKind;
      if (!w || !POPOVERS.has(kind)) return;
      w.hideOverlay();
      w.emit('overlay-picked', { kind });
    });
  }

  // ---------------------------------------------------------------- the popover
  // Other computers signed in to Lumio Sync (phones get chats, not tabs);
  // null when sync isn't set up here.
  async devices(w) {
    const s = this.syncOf(w);
    if (!s?.keys || s.status !== 'ready') return null;
    const cache = this.caches.get(s);
    if (cache && this.now() - cache.at < DEVICES_FRESH) return cache.list;
    try {
      const res = await Promise.race([s.api('/api/sync'), new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 2500))]);
      const list = (res.devices || []).filter((d) => d.kind === 'computer' && d.id !== s.deviceId)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .map((d) => ({ id: d.id, name: d.name || 'Computer', platform: d.platform || null, lastSeen: d.lastSeen || null }));
      this.caches.set(s, { at: this.now(), list });
      return list;
    } catch {
      return this.caches.get(s)?.list ?? null;
    }
  }

  // What the popover shows. url/title: a link or picture to share instead of
  // the page (the right-click menu's QR codes).
  async info(w, { tabId, view = 'main', url: forUrl, title: forTitle, anchor } = {}) {
    const tab = w.tabs.get(Number(tabId)) || w.tabs.active;
    if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) this.anchors.set(w, { x: Math.round(anchor.x), y: Math.round(anchor.y) });
    const p = this.pending.get(w);
    const asked = p && p.tabId === tab?.id ? p.data : null;
    const pageUrl = tab ? w.tabs.displayUrl(tab) : '';
    const other = !asked && web(forUrl) ? forUrl : null;
    const url = asked ? asked.url : other || pageUrl;
    const isPage = !asked && !other;
    return {
      kind: 'share',
      tabId: tab?.id ?? null,
      view: ['main', 'qr', 'devices'].includes(view) ? view : 'main',
      url,
      title: asked ? asked.title : other ? String(forTitle || '').slice(0, 300) : tab?.title || '',
      host: hostOf(url),
      favicon: isPage ? tab?.favicon || null : null,
      web: asked ? { ...asked, host: hostOf(pageUrl) } : null,
      devices: web(url) && !w.incognito ? await this.devices(w) : null,
      native: process.platform === 'darwin',
      page: isPage ? { screenshot: !!tab?.view, save: !!tab?.view && /^(https?|file):/i.test(pageUrl), apps: !w.incognito && !!tab?.view && web(pageUrl) } : null,
    };
  }

  // A choice in the popover (or a menu): `action` with the popover's url and title.
  async act(w, { action, tabId, url, title, deviceId, png, name } = {}) {
    const tab = w.tabs.get(Number(tabId)) || w.tabs.active;
    const p = this.pending.get(w);
    const asked = p && p.tabId === tab?.id ? p.data : null;
    const link = asked ? asked.url : (web(url) || /^file:/i.test(url || '')) ? url : (tab ? w.tabs.displayUrl(tab) : '');
    const done = (text) => {
      if (asked) this.settle(w, { ok: true });
      w.hideOverlay();
      w.emit('overlay-picked', { kind: 'share' });
      if (text) w.emit('toast', { text });
    };
    if (action === 'copy') {
      clipboard.writeText(asked && !asked.url ? [asked.title, asked.text].filter(Boolean).join('\n') : link);
      done(asked && !asked.url ? 'Copied' : 'Link copied');
    } else if (action === 'send') {
      const s = this.syncOf(w);
      const device = ((s && this.caches.get(s)?.list) || []).find((d) => d.id === deviceId);
      const companion = this.companionOf(w);
      if (!device || !web(link) || w.incognito || !companion) return;
      try {
        await companion.sendTab(device.id, { url: link, title: String(asked?.title || title || tab?.title || '').slice(0, 300) });
        done(`Sent to ${device.name}`);
      } catch (err) {
        done(err?.message?.startsWith('Turn on') ? err.message : 'Couldn’t send this tab. Try again.');
      }
    } else if (action === 'native' && process.platform === 'darwin') {
      const at = this.anchors.get(w);
      if (asked) this.settle(w, { ok: true });
      w.hideOverlay();
      w.emit('overlay-picked', { kind: 'share' });
      const item = link ? { urls: [link] } : { texts: [[asked?.title, asked?.text].filter(Boolean).join('\n')] };
      new ShareMenu(item).popup({ window: w.win, ...(at || {}) });
    } else if (action === 'qr-copy' || action === 'qr-save') {
      const img = png instanceof Uint8Array && png.length < 8 * 1024 * 1024 ? nativeImage.createFromBuffer(Buffer.from(png)) : null;
      if (!img || img.isEmpty()) return;
      if (action === 'qr-copy') { clipboard.writeImage(img); done('QR code copied'); return; }
      const file = await this.saveImage(w, img, `${String(name || 'QR code').replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)}.png`);
      if (file) done('QR code saved');
    } else if (!asked && tab) {
      w.hideOverlay();
      w.emit('overlay-picked', { kind: 'share' });
      if (action === 'save') this.savePage(w, tab);
      else if (action === 'screenshot') this.screenshots?.start(w);
      else if (action === 'install' || action === 'shortcut') this.apps?.prompt(w, tab, { shortcut: action === 'shortcut' });
    }
  }

  async saveImage(w, img, fileName) {
    const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return null;
    try { fs.writeFileSync(filePath, img.toPNG()); return filePath; } catch { w.emit('toast', { text: 'Couldn’t save the picture' }); return null; }
  }

  // From the menus and the right-click menu.
  command(w, what, { url, title } = {}) {
    const tab = w?.tabs.active;
    if (!tab) return;
    if (what === 'copy') {
      const link = w.tabs.displayUrl(tab);
      if (!link) return;
      clipboard.writeText(link);
      w.emit('toast', { text: 'Link copied' });
    } else if (what === 'qr' || what === 'send' || what === 'open') {
      w.win.webContents.focus();
      w.emit('share-open', { tabId: tab.id, view: what === 'open' ? 'main' : what === 'send' ? 'devices' : 'qr', ...(web(url) ? { url, title: title || '' } : {}) });
    } else if (what === 'screenshot') this.screenshots?.start(w);
    else if (what === 'save') this.savePage(w, tab);
    else if (what === 'install' || what === 'shortcut') this.apps?.prompt(w, tab, { shortcut: what === 'shortcut' });
    else if (what === 'native' && process.platform === 'darwin') {
      const link = w.tabs.displayUrl(tab);
      if (web(link)) new ShareMenu({ urls: [link] }).popup({ window: w.win });
    }
  }

  // ---------------------------------------------------------------- websites' Share buttons
  // navigator.share() from a page: resolves { ok } when the person shares,
  // or { error, message } (a DOMException's name) when they don't.
  async webShare(e, data) {
    const found = this.tabOfWc(e.sender);
    const aw = found ? null : this.apps?.windowFor?.(e.sender);
    if ((!found && !aw) || e.senderFrame !== e.sender.mainFrame || !web(e.sender.getURL())) return { error: 'NotAllowedError', message: 'Sharing isn’t allowed here.' };
    // The click is checked again in Lumio's own world: the page's world can fake navigator.userActivation.
    const clicked = await e.sender.executeJavaScriptInIsolatedWorld(WORLD, [{ code: 'navigator.userActivation.isActive' }]).catch(() => false);
    if (clicked !== true) return { error: 'NotAllowedError', message: 'Must be handling a user gesture to perform a share request.' };
    if (aw) return this.appShare(aw, e, data);
    const { w, tab } = found;
    if (w.tabs.activeId !== tab.id || !w.win.isFocused()) return { error: 'NotAllowedError', message: 'The tab isn’t in front.' };
    const clean = cleanShareData(data, e.sender.getURL());
    if (!clean) return { error: 'DataError', message: 'Nothing to share.' };
    this.settle(w, { error: 'AbortError', message: 'Share canceled' }); // an earlier one, never answered
    return new Promise((resolve) => {
      const p = { tabId: tab.id, data: clean, resolve };
      this.pending.set(w, p);
      w.win.webContents.focus();
      w.emit('share-open', { tabId: tab.id, view: 'main' });
      // The popover never came up (the window went away, another tab came up first).
      setTimeout(() => { if (this.pending.get(w) === p && w.overlayKind !== 'share') this.settle(w, { error: 'AbortError', message: 'Share canceled' }); }, this.openWait);
    });
  }

  // A Share button in an installed app's window (main/apps.js), which has no
  // address bar to hang the popover from: the Mac's share sheet, at the
  // pointer. The sheet doesn't say whether something was shared, so closing
  // it counts as shared. Elsewhere sites get NotAllowedError and fall back.
  appShare(aw, e, data) {
    if (process.platform !== 'darwin' || !aw.win.isFocused()) return { error: 'NotAllowedError', message: 'Sharing isn’t allowed here.' };
    const clean = cleanShareData(data, e.sender.getURL());
    if (!clean) return { error: 'DataError', message: 'Nothing to share.' };
    const text = [clean.title, clean.text].filter(Boolean).join('\n');
    const item = { ...(clean.url ? { urls: [clean.url] } : {}), ...(text ? { texts: [text] } : {}) };
    return new Promise((resolve) => new ShareMenu(item).popup({ window: aw.win, callback: () => resolve({ ok: true }) }));
  }

  settle(w, result) {
    const p = this.pending.get(w);
    if (!p) return;
    this.pending.delete(w);
    p.resolve(result);
  }

  // The popover closed (or another took its place), or another tab came up.
  overlayClosed(w, kind) { if (kind === 'share') this.settle(w, { error: 'AbortError', message: 'Share canceled' }); }
  tabChanged(w, tab) { if (this.pending.get(w)?.tabId !== tab?.id) this.settle(w, { error: 'AbortError', message: 'Share canceled' }); }

  // ---------------------------------------------------------------- tabs from other devices
  // profile: the profile whose Lumio Sync it came through (it opens there).
  receiveTab({ url, title, from }, profile) {
    if (!Notification.isSupported()) { this.openUrl(url, profile); return; }
    const n = new Notification({ title: `Tab from ${from || 'your other computer'}`, body: `${title || hostOf(url)}\n${hostOf(url)}`.slice(0, 240) });
    n.on('click', () => this.openUrl(url, profile));
    n.show();
    this.notices = [...this.notices.slice(-9), n];
  }

  // Browser UI calls (main.js routes them to the window they came from).
  register({ handle, on }) {
    handle('share:info', (w, opts) => this.info(w, opts || {}));
    on('share:action', (w, payload) => { this.act(w, payload || {}).catch(() => {}); });
    on('share:focus', (w) => w.overlay.webContents.focus());
    on('share:refocus', (w) => w.win.webContents.focus());
    ipcMain.handle('share:web', (e, data) => this.webShare(e, data));
  }
}

module.exports = { ShareTools, cleanShareData };
