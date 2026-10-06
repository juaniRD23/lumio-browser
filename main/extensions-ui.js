// The extensions' browser UI, between main/extensions.js and the windows:
//  - the puzzle-piece menu (renderer/ui/overlay-extensions.js): every
//    extension that's on, run it, pin it to the toolbar, set its site access
//  - the pinned toolbar buttons (renderer/ui/extensions-bar.js) and their
//    right-click menu
//  - keyboard shortcuts for extension commands, as hidden items in the
//    application menu (so they work whatever has focus in the window)
//  - an extension's new tab page, and the "Change it back / Keep it"
//    question the first time it shows
//  - lumio://extensions: the details page, shortcuts page and developer tools
const { Menu, dialog } = require('electron');
const commands = require('./extension-commands');

const MAC = process.platform === 'darwin';
const MENU_WIDTH = 360;

// Which site access choice applies on the page you're on: an extension
// limited to other sites only runs here when clicked.
const accessChoice = (item) => (item.access === 'all' ? 'all' : item.access === 'sites' && item.siteListed ? 'site' : 'click');

class ExtensionsUI {
  // extensions: ExtensionManager. windows(): open windows. current(): the
  // focused one. openInternal(url), menuChanged().
  constructor({ extensions, store, windows, current, openInternal, menuChanged }) {
    this.ext = extensions;
    this.store = store;
    this.windows = windows;
    this.current = current;
    this.openInternal = openInternal;
    this.menuChanged = menuChanged;
    this.recording = null; // the shortcuts page where a shortcut is being typed (its webContents)
    this.keys = null; // the extension shortcuts, kept until extensions or shortcuts change
    this.reserved = null; // Lumio's own menu shortcuts
    this.menuClosedAt = new WeakMap(); // window -> when its puzzle menu last closed
    this.ntpAsked = new Set(); // asked this launch (answered "later")
    this.ntp = undefined; // the extension new tab page, worked out again after changes
    extensions.reservedKeys = () => this.reservedAccelerators();
  }

  get ready() { return !!this.ext?.ece; }

  register({ handle, on, internalHandle }) {
    // ---- the toolbar and the puzzle menu
    handle('extensions:toolbar', (w) => ({ available: this.ready && !w.incognito, pinned: this.ready && !w.incognito ? this.ext.pinned() : [] }));
    on('extensions:menu', (w, { rect } = {}) => this.toggleMenu(w, rect));
    on('extensions:menu-close', (w, { refocus } = {}) => this.closeMenu(w, { refocus }));
    on('extensions:menu-act', (w, msg) => this.menuAct(w, msg || {}));
    on('extensions:context', (w, { id, x, y } = {}) => this.actionMenu(w, String(id || ''), x, y));
    on('extensions:ntp', (w, { decision } = {}) => this.ntpDecide(w, decision));

    // ---- lumio://extensions
    const page = (channel, fn) => internalHandle(channel, ['extensions'], fn);
    page('page:extension-details', async (_ctx, key) => (this.ready ? this.ext.details(String(key || '')) : null));
    page('page:extension-set-access', async (_ctx, key, next) => ({ ok: await this.ext.setSiteAccess(String(key || ''), next || {}) }));
    page('page:extension-file-access', async (_ctx, key, on_) => { await this.ext.setFileAccess(String(key || ''), !!on_); return { ok: true }; });
    page('page:extension-pin', (_ctx, id, on_) => { this.ext.setPinned(String(id || ''), !!on_); return { ok: true }; });
    page('page:extension-shortcuts', () => ({ available: this.ready, mac: MAC, extensions: this.ready ? this.ext.shortcuts() : [] }));
    page('page:extension-set-shortcut', (_ctx, id, name, shortcut) => {
      this.keys = null;
      return this.ext.setShortcut(String(id || ''), String(name || ''), String(shortcut || ''), this.reservedAccelerators());
    });
    page('page:extension-recording', ({ sender }, on_) => this.setRecording(on_ ? sender : null));
    page('page:extension-update', () => this.ext.updateAll());
    page('page:extension-pack', ({ w }) => this.pack(w));
  }

  // ---------------------------------------------------------------- the puzzle menu
  menuPayload(w) {
    const tab = w.tabs.active;
    const url = tab ? w.tabs.displayUrl(tab) : '';
    return { kind: 'extensions', items: this.ext.menu(url).map((it) => ({ ...it, choice: accessChoice(it) })), mac: MAC };
  }

  toggleMenu(w, rect) {
    if (!this.ready || w.incognito) return;
    if (w.overlayKind === 'extensions') { this.closeMenu(w); return; }
    // The click that opened it again just closed it (the menu closes when it loses focus).
    if (Date.now() - (this.menuClosedAt.get(w) || 0) < 300) return;
    // Another dropdown was open: the window's UI forgets it.
    if (w.overlayKind) w.emit('overlay-picked', { kind: w.overlayKind });
    const r = rect && Number.isFinite(rect.right) ? rect : { right: w.win.getContentSize()[0] - 120, bottom: 84 };
    // The overlay's 12px side margins hold the shadow; the card lines up with the button's right edge.
    w.showOverlay({ x: r.right - MENU_WIDTH - 12, y: r.bottom + 4, width: MENU_WIDTH + 24, height: 420 }, { ...this.menuPayload(w), fresh: true });
    w.overlay.webContents.focus();
  }

  closeMenu(w, { refocus = false } = {}) {
    if (w.overlayKind !== 'extensions') return;
    this.menuClosedAt.set(w, Date.now());
    w.hideOverlay();
    if (refocus) { w.win.webContents.focus(); w.emit('ext-menu-closed', { refocus: true }); }
  }

  refreshMenu(w) {
    if (w.overlayKind === 'extensions') w.overlay.webContents.send('overlay-data', this.menuPayload(w));
  }

  async menuAct(w, { act, id, key, choice }) {
    id = String(id || '');
    key = String(key || '');
    if (act === 'activate') { this.closeMenu(w); this.activate(id, w); return; }
    if (act === 'manage') { this.closeMenu(w); this.openInternal('lumio://extensions/'); return; }
    if (act === 'details') { this.closeMenu(w); this.openInternal(`lumio://extensions/?id=${encodeURIComponent(key)}`); return; }
    if (act === 'pin' || act === 'unpin') this.ext.setPinned(id, act === 'pin');
    if (act === 'access') {
      const tab = w.tabs.active;
      let host = '';
      try { host = new URL(tab ? w.tabs.displayUrl(tab) : '').hostname; } catch { /* not a site */ }
      if (await this.ext.setAccessForSite(key, choice, host) && tab?.view && /^https?:/.test(w.tabs.displayUrl(tab))) {
        // Page scripts only start or stop with a fresh load, like in Chrome.
        w.emit('toast', { text: 'Reload the page to apply the new site access' });
      }
    }
    this.refreshMenu(w);
  }

  // Run an extension's toolbar button (its popup, or its click event): the
  // window's UI does it, so the popup opens under the right button.
  activate(id, w = this.current()) {
    if (!w || w.incognito || !this.ext.api.getExtension(id)) return;
    w.emit('ext-activate', { id });
  }

  // Right-click on a pinned toolbar button.
  actionMenu(w, id, x, y) {
    const item = this.ext.menu(w.tabs.active ? w.tabs.displayUrl(w.tabs.active) : '').find((e) => e.id === id);
    if (!item) return;
    const own = (() => { try { return this.ext.ece.ctx.store.buildMenuItems(id, 'browser_action') || []; } catch { return []; } })();
    const options = this.ext.list().find((e) => e.id === id)?.options;
    const choices = [
      ['click', 'When you click the extension'],
      ...(item.host ? [['site', `On ${item.host}`]] : []),
      ['all', 'On all sites'],
    ];
    const template = [
      { label: item.name, enabled: false },
      { type: 'separator' },
      ...own,
      ...(own.length ? [{ type: 'separator' }] : []),
      ...(item.here !== 'none' || item.access !== 'all' ? [{
        label: 'This can read and change site data',
        enabled: item.changeable,
        submenu: choices.map(([choice, label]) => ({
          label,
          type: 'radio',
          checked: accessChoice(item) === choice,
          click: () => this.menuAct(w, { act: 'access', key: item.key, choice }),
        })),
      }] : []),
      { label: item.pinned ? 'Unpin' : 'Pin', click: () => this.ext.setPinned(id, !item.pinned) },
      ...(options ? [{ label: 'Options', click: () => w.tabs.create(`chrome-extension://${id}/${options.replace(/^\//, '')}`) }] : []),
      { label: 'Manage Extension', click: () => this.openInternal(`lumio://extensions/?id=${encodeURIComponent(item.key)}`) },
      { label: 'Remove from Lumio…', click: () => this.confirmRemove(w, item) },
    ];
    Menu.buildFromTemplate(template).popup({ window: w.win, ...(Number.isFinite(x) ? { x: Math.round(x), y: Math.round(y) } : {}) });
  }

  async confirmRemove(w, item) {
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Remove “${item.name}”?`,
    });
    if (response === 0) await this.ext.remove(item.key);
  }

  // ---------------------------------------------------------------- shortcuts
  // While a shortcut is typed on the shortcuts page, extension shortcuts are
  // off. They come back when that page is closed or leaves, even if it never
  // said it stopped.
  setRecording(wc) {
    if (this.recording === wc) return;
    const was = this.recording;
    this.recording = wc;
    if (was && !was.isDestroyed()) { was.off('destroyed', this.stopRecording); was.off('did-start-navigation', this.stopRecording); }
    if (wc) { wc.once('destroyed', this.stopRecording); wc.once('did-start-navigation', this.stopRecording); }
    this.menuChanged();
  }

  stopRecording = () => this.setRecording(null);

  // Hidden application-menu items for the extension shortcuts (none while
  // the person is typing a new one).
  menuKeys() {
    if (!this.ready || this.recording) return [];
    this.keys ||= this.ext.activeShortcuts();
    return this.keys.filter((s) => s.accelerator).map((s) => ({
      id: `ext-cmd:${s.id}:${s.name}`,
      label: s.accelerator,
      accelerator: s.accelerator,
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => {
        const w = this.current();
        if (!w || w.incognito) return;
        this.ext.runCommand(s.id, s.name, w.tabs.wc());
      },
    }));
  }

  // Shortcuts Lumio's own menu uses (canonical spelling). They don't change
  // while Lumio runs, so they're worked out once the menu is there.
  reservedAccelerators() {
    if (this.reserved) return this.reserved;
    const out = new Set();
    const walk = (menu) => {
      for (const item of menu?.items || []) {
        if (item.accelerator && !String(item.id || '').startsWith('ext-cmd:')) out.add(commands.canonical(item.accelerator, { mac: MAC }));
        if (item.submenu) walk(item.submenu);
      }
    };
    const menu = Menu?.getApplicationMenu?.() || null; // (no menu in tests)
    walk(menu);
    if (menu && out.size) this.reserved = out;
    return out;
  }

  // ---------------------------------------------------------------- the new tab page
  // The extension page that replaces the new tab page, if any (tabs ask
  // often, so it's kept until extensions change).
  override() {
    if (!this.ready) return null;
    if (this.ntp === undefined) this.ntp = this.ext.newTabOverride();
    return this.ntp;
  }

  // What a new tab loads: an extension's page if one replaces it.
  newTabUrl(w) {
    if (w?.incognito) return null;
    const o = this.override();
    if (!o) return null;
    const kept = this.store.settings.ntpOverrideKept || [];
    if (!kept.includes(o.id) && !this.ntpAsked.has(o.id)) setTimeout(() => this.askNtp(w, o), 400);
    return o.url;
  }

  isNewTabUrl(url) {
    const o = this.override();
    return !!o && String(url || '').split(/[?#]/)[0] === o.url;
  }

  askNtp(w, o, tries = 0) {
    if (w.closed || this.ntpAsked.has(o.id)) return;
    // Another popup is up (address suggestions while typing, a dialog): ask a
    // little later rather than replace it.
    if (w.overlayKind) { if (tries < 20) setTimeout(() => this.askNtp(w, o, tries + 1), 3000); return; }
    // A window that just opened (at launch) may still be loading its overlay page.
    const ov = w.overlay.webContents;
    if (ov.isLoading()) { ov.once('did-finish-load', () => this.askNtp(w, o)); return; }
    this.ntpAsked.add(o.id);
    const b = w.tabs.active?.view?.getBounds() || { x: 0, y: 84, width: w.win.getContentSize()[0], height: 600 };
    const width = Math.min(420, b.width - 24);
    w.ntpPrompt = o;
    // It doesn't take the keyboard: the person is likely typing an address
    // in the new tab, and a stray Enter mustn't turn the extension off.
    w.showOverlay({ x: b.x + b.width - width - 12, y: b.y + 8, width: width + 24, height: 230 }, { kind: 'ntp-override', name: o.name });
  }

  async ntpDecide(w, decision) {
    const o = w.ntpPrompt;
    w.ntpPrompt = null;
    if (w.overlayKind === 'ntp-override') w.hideOverlay();
    if (!o) return;
    if (decision === 'keep') {
      this.store.setSetting('ntpOverrideKept', [...new Set([...(this.store.settings.ntpOverrideKept || []), o.id])]);
    } else if (decision === 'revert') {
      // Turn the extension off, and give open new tabs Lumio's page back.
      await this.ext.setEnabled(o.key, false);
      for (const win of this.windows()) {
        for (const t of win.tabs.tabs) if (String(t.url || '').startsWith(`chrome-extension://${o.id}/`)) win.tabs.navigate('lumio://newtab/', t.id);
      }
      w.emit('toast', { text: `Turned off “${o.name}”. You can turn it back on in Extensions.` });
    }
    w.tabs.wc()?.focus();
  }

  // ---------------------------------------------------------------- developer mode
  async pack(w) {
    const pick = await dialog.showOpenDialog(w.win, { properties: ['openDirectory'], message: 'Choose the extension folder to pack (with manifest.json)' });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    const key = await dialog.showMessageBox(w.win, {
      type: 'question', buttons: ['Make a New Key', 'Use My Key…', 'Cancel'], defaultId: 0, cancelId: 2,
      message: 'Sign it with a private key?',
      detail: 'A new key gives the extension a new ID. To pack a new version of an extension you packed before, use its .pem key.',
    });
    if (key.response === 2) return { ok: false, canceled: true };
    let keyFile = null;
    if (key.response === 1) {
      const k = await dialog.showOpenDialog(w.win, { properties: ['openFile'], filters: [{ name: 'Private key', extensions: ['pem'] }] });
      if (k.canceled || !k.filePaths[0]) return { ok: false, canceled: true };
      keyFile = k.filePaths[0];
    }
    return this.ext.pack(pick.filePaths[0], keyFile);
  }

  // Changes from the manager: refresh any open puzzle menu.
  changed() {
    this.ntp = undefined;
    this.keys = null;
    for (const w of this.windows()) this.refreshMenu(w);
  }
}

module.exports = { ExtensionsUI, MENU_WIDTH, accessChoice };
