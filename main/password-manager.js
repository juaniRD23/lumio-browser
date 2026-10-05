// Connects saved passwords (passwords.js) to tabs and the browser UI:
//  - after a sign-in the person typed, offer to save or update it;
//  - under a sign-in field they clicked, list saved accounts (or suggest a
//    strong password on sign-up forms) in Lumio's own dropdown;
//  - fill only the page that asked, only after a choice, and only while it's
//    still on the same site;
//  - confirm who they are (Touch ID / Mac password, Windows Hello) before
//    showing, copying or exporting passwords;
//  - passkeys: when a site calls navigator.credentials.create()/get(), ask in
//    Lumio's own prompt, confirm it's them, then create or use a passkey
//    (passkeys.js is the authenticator);
//  - security keys (USB or NFC): the page uses the browser's own WebAuthn
//    instead, while Lumio says to touch the key (Windows shows its own dialog).
// Page messages come from the isolated tab preload (preload/internal.js).
const { ipcMain, clipboard, dialog, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const { PasswordStore, generatePassword, siteKey } = require('./passwords');
const { PasskeyStore, WebAuthnError, validRpId } = require('./passkeys');
const { windowsHello } = require('./win/hello');

const AUTH_MS = 3 * 60 * 1000;
const PROMPT_MS = 10 * 60 * 1000;

class PasswordManager {
  constructor({ dir, safeStorage, settings, helper, findTab, toast }) {
    this.store = new PasswordStore(dir, safeStorage);
    this.passkeys = new PasskeyStore(dir, safeStorage);
    this.pkPending = new Map(); // prompt id -> { resolve, kind, pk, origin, rpId, w, wcId, accounts }
    this.keyWaits = new Map(); // webContents id -> { id, w, resolve } while a page waits for a security key
    this.settings = settings; // the app Store (for offer/autofill switches)
    this.helper = helper;
    this.findTab = findTab; // (webContents) -> { w, tab } | null
    this.toast = toast; // (w, text)
    this.pending = new Map(); // prompt id -> { origin, host, username, password, action, entryId, w, tabId, at }
    this.sessions = new Map(); // webContents id -> { origin, ids, generated }
    this.generatedFor = new Map(); // webContents id -> password we suggested there
    this.authUntil = 0;
    let nextPrompt = 1;
    this.nextPromptId = () => nextPrompt++;
  }

  // The page's origin, but only for the tab's own top frame on http(s).
  static origin(e) {
    const frame = e.senderFrame;
    if (!frame || frame !== e.sender.mainFrame) return null;
    try {
      const u = new URL(frame.url);
      return /^https?:$/.test(u.protocol) ? u.origin : null;
    } catch { return null; }
  }

  register() {
    ipcMain.on('pw:captured', (e, data) => this.captured(e, data));
    ipcMain.handle('pw:query', (e, data) => this.query(e, data));
    ipcMain.on('pw:show', (e, rect) => this.show(e, rect));
    ipcMain.handle('pk:request', (e, req) => this.passkeyRequest(e, req || {}));
    ipcMain.on('pk:cancel', (e) => this.passkeyCancel(e.sender.id));
    ipcMain.handle('pk:key-wait', (e) => this.keyWait(e));
    ipcMain.on('pk:key-done', (e) => this.keyDone(e.sender.id));
    ipcMain.on('pw:hide', (e) => {
      const found = this.findTab(e.sender);
      if (found && found.w.overlayKind === 'autofill') found.w.hideOverlay();
    });
  }

  // ------------------------------------------------------------ saving
  captured(e, { username = '', password = '', isNew = false } = {}) {
    const origin = PasswordManager.origin(e);
    const found = this.findTab(e.sender);
    if (!origin || !found || typeof password !== 'string' || !password || password.length > 512) return;
    username = String(username).slice(0, 300);
    const { w, tab } = found;
    // A password Lumio suggested on this page is saved without asking.
    if (this.generatedFor.get(e.sender.id) === password) {
      this.generatedFor.delete(e.sender.id);
      if (this.store.available()) {
        this.store.save({ origin, username, password });
        this.toast(w, 'Password saved');
      }
      return;
    }
    if (this.settings.settings.offerPasswords === false || !this.store.available() || this.store.isNever(origin)) return;
    const c = this.store.classify(origin, username, password);
    if (c.action === 'none') { this.store.markUsed(c.id); return; }
    // One prompt per tab: a newer sign-in replaces an older unanswered one.
    for (const [id, p] of this.pending) if (p.w === w && p.tabId === tab.id) this.pending.delete(id);
    const id = this.nextPromptId();
    const host = new URL(origin).host;
    this.pending.set(id, { origin, host, username, password, action: isNew && c.action === 'save' && !username ? 'save' : c.action, entryId: c.id, w, tabId: tab.id, at: Date.now() });
    w.emit('passwords-prompt', { id, host, username, action: c.action, length: password.length, tabId: tab.id });
  }

  pendingFor(w, id) {
    const p = this.pending.get(id);
    if (!p || p.w !== w) return null;
    if (Date.now() - p.at > PROMPT_MS) { this.pending.delete(id); return null; }
    return p;
  }

  revealPending(w, id) {
    return this.pendingFor(w, id)?.password ?? null;
  }

  decide(w, { id, decision, username } = {}) {
    const p = this.pendingFor(w, id);
    if (!p) return;
    this.pending.delete(id);
    if (decision === 'never') { this.store.addNever(p.origin); return; }
    if (decision !== 'save') return;
    const name = typeof username === 'string' ? username.trim().slice(0, 300) : p.username;
    try {
      if (p.action === 'update' && p.entryId && name === p.username) this.store.update(p.entryId, { password: p.password });
      else this.store.save({ origin: p.origin, username: name, password: p.password });
      this.toast(w, p.action === 'update' ? 'Password updated' : 'Password saved');
    } catch (err) {
      this.toast(w, err.message);
    }
  }

  // ------------------------------------------------------------ suggesting + filling
  query(e, { newPassword = false } = {}) {
    const origin = PasswordManager.origin(e);
    if (!origin || this.settings.settings.autofillPasswords === false || !this.store.available()) return null;
    const accounts = this.store.forOrigin(origin);
    const generated = newPassword ? generatePassword() : null;
    if (!accounts.length && !generated) return null;
    this.sessions.set(e.sender.id, { origin, ids: accounts.map((a) => a.id), generated });
    return { accounts: accounts.length, generate: !!generated };
  }

  show(e, rect) {
    const found = this.findTab(e.sender);
    const session = this.sessions.get(e.sender.id);
    const origin = PasswordManager.origin(e);
    if (!found || !session || session.origin !== origin || !rect) return;
    const { w, tab } = found;
    if (tab.id !== w.tabs.activeId || !tab.view) return;
    if (w.overlayKind === 'feedback') return; // never over a report being written
    const b = tab.view.getBounds();
    const zoom = e.sender.getZoomFactor();
    const width = Math.max(280, Math.min(420, (rect.width || 0) * zoom));
    const accounts = session.ids.map((id) => this.store.get(id)).filter(Boolean).map((a) => ({ id: a.id, username: a.username }));
    w.showOverlay(
      { x: b.x + rect.x * zoom - 12, y: b.y + rect.y * zoom + 2, width: width + 24, height: 80 + accounts.length * 44 + (session.generated ? 70 : 0) },
      { kind: 'autofill', host: new URL(origin).host, accounts, generated: session.generated },
    );
  }

  // The person picked something in the dropdown: fill that tab's page.
  fill(w, { id, generate } = {}) {
    const tab = w.tabs.active;
    const wc = tab?.view?.webContents;
    const session = wc && this.sessions.get(wc.id);
    w.hideOverlay();
    if (!session) return;
    let origin;
    try { origin = new URL(wc.mainFrame.url).origin; } catch { return; }
    if (origin !== session.origin) return; // the page changed site since the dropdown opened
    if (generate && session.generated) {
      this.generatedFor.set(wc.id, session.generated);
      wc.mainFrame.send('pw:fill', { password: session.generated, generated: true });
      return;
    }
    if (!session.ids.includes(id)) return;
    const entry = this.store.get(id);
    const password = this.store.secret(id);
    if (!entry || password == null || siteKey(entry.origin) !== siteKey(origin)) return;
    wc.mainFrame.send('pw:fill', { username: entry.username, password });
    this.store.markUsed(id);
  }

  // ------------------------------------------------------------ confirming it's you
  async authorize(w, reason) {
    if (Date.now() < this.authUntil) return true;
    let ok = false;
    const testAuth = process.env.LUMIO_TEST && process.env.LUMIO_TEST_AUTH;
    if (testAuth) ok = testAuth === 'allow';
    else if (process.platform === 'darwin' && this.helper?.available()) {
      const r = await this.helper.request('authenticate', { reason }, 120000).catch(() => null);
      ok = r?.unavailable ? await this.confirm(w) : !!r?.authenticated;
    } else if (process.platform === 'win32') {
      const r = await windowsHello(reason);
      ok = r === 'unavailable' ? await this.confirm(w) : r === 'verified';
    } else {
      ok = await this.confirm(w);
    }
    if (ok) this.authUntil = Date.now() + AUTH_MS;
    return ok;
  }

  async confirm(w) {
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'warning',
      buttons: ['Show passwords', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Show your saved passwords?',
      detail: 'This computer has no Touch ID, Windows Hello or password check that Lumio can use, so anyone using it can see them.',
    });
    return response === 0;
  }

  // ------------------------------------------------------------ passkeys
  // A site called navigator.credentials.create()/get() (preload/internal.js).
  // Resolves with { credential } or { error, message } for the page.
  async passkeyRequest(e, req) {
    const origin = PasswordManager.origin(e);
    const found = this.findTab(e.sender);
    const no = (message, error = 'NotAllowedError') => ({ error, message });
    if (!origin || !found) return no('Passkeys work on websites in a tab.');
    if (!this.passkeys.available()) return no('Lumio can’t store passkeys on this computer.');
    const kind = req.kind === 'create' ? 'create' : 'get';
    const pk = req.publicKey && typeof req.publicKey === 'object' ? req.publicKey : {};
    let rpId;
    let accounts = [];
    try {
      if (kind === 'create') {
        if (pk.authenticatorSelection?.authenticatorAttachment === 'cross-platform') return { native: true }; // a security key
        rpId = String(pk.rp?.id || new URL(origin).hostname).toLowerCase();
        if (!validRpId(rpId, origin)) throw new WebAuthnError('SecurityError', 'This site can’t use that passkey domain.');
      } else {
        const c = this.passkeys.candidates(pk, origin);
        rpId = c.rpId;
        accounts = c.list.map((k) => ({ id: k.id, userName: k.userName, displayName: k.displayName }));
        // The site wants a passkey Lumio doesn't have: a security key may have it.
        if (!accounts.length && (pk.allowCredentials || []).length && req.mediation !== 'conditional') return { native: true };
      }
    } catch (err) {
      return no(err.message, err.name || 'NotAllowedError');
    }
    // A passkey-autofill request with nothing to offer just waits, like Chrome.
    if (kind === 'get' && req.mediation === 'conditional' && !accounts.length) return new Promise(() => {});
    this.passkeyCancel(e.sender.id); // one prompt per tab
    const { w, tab } = found;
    const id = this.nextPromptId();
    return new Promise((resolve) => {
      const entry = { id, resolve, kind, pk, origin, rpId, w, wcId: e.sender.id, accounts };
      this.pkPending.set(id, entry);
      const b = tab.view?.getBounds() || { x: 0, y: 90, width: 800 };
      const width = 380;
      w.showOverlay(
        { x: b.x + b.width - width - 4, y: b.y + 4, width: width + 24, height: 230 + accounts.length * 52 },
        {
          kind: 'passkey',
          prompt: { id, mode: kind === 'create' ? 'create' : accounts.length ? 'get' : 'none', rpId, host: new URL(origin).host, userName: String(pk.user?.name || ''), displayName: String(pk.user?.displayName || ''), accounts },
          accent: '',
        },
      );
    });
  }

  // The page gave up (AbortSignal), went away, or a newer request came in.
  passkeyCancel(wcId) {
    for (const [id, p] of this.pkPending) {
      if (p.wcId !== wcId) continue;
      this.pkPending.delete(id);
      p.resolve({ error: 'NotAllowedError', message: 'The request was cancelled.' });
      if (p.w.overlayKind === 'passkey') p.w.hideOverlay();
    }
  }

  // The passkey prompt was closed without a choice (another click, tab switch...).
  passkeyClosed(w) {
    for (const [id, p] of this.pkPending) {
      if (p.w !== w) continue;
      this.pkPending.delete(id);
      p.resolve({ error: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' });
    }
    // A page waiting for a security key keeps waiting; only the note went away.
    for (const [wcId, k] of this.keyWaits) if (k.w === w) { this.keyWaits.delete(wcId); k.resolve('closed'); }
  }

  // A page is waiting for a security key (the browser's own WebAuthn): say
  // what to do, with a way to stop. Resolves 'cancel' if the person cancels.
  // Windows shows its own security key dialog, so there's nothing to add there.
  keyWait(e) {
    const origin = PasswordManager.origin(e);
    const found = this.findTab(e.sender);
    if (!origin || !found || process.platform === 'win32') return 'none';
    this.keyDone(e.sender.id, 'closed'); // one note per tab
    const { w, tab } = found;
    // Only for the tab in front, and never over a report being written.
    if (tab.id !== w.tabs.activeId || w.overlayKind === 'feedback') return 'none';
    const id = this.nextPromptId();
    return new Promise((resolve) => {
      this.keyWaits.set(e.sender.id, { id, w, resolve });
      w.keyNoteId = id;
      const b = tab.view?.getBounds() || { x: 0, y: 90, width: 800 };
      const width = 380;
      w.showOverlay(
        { x: b.x + b.width - width - 4, y: b.y + 4, width: width + 24, height: 200 },
        { kind: 'passkey', prompt: { id, mode: 'key', rpId: '', host: new URL(origin).host, userName: '', displayName: '', accounts: [] }, accent: '' },
      );
    });
  }

  keyDone(wcId, answer = 'done') {
    const k = this.keyWaits.get(wcId);
    if (!k) return;
    this.keyWaits.delete(wcId);
    k.resolve(answer);
    // Only this note: another tab's passkey question stays.
    if (k.w.overlayKind === 'passkey' && k.w.keyNoteId === k.id) k.w.hideOverlay();
  }

  // The person answered the prompt: confirm it's them, then create or sign.
  async passkeyDecide(w, { id, decision, account } = {}) {
    for (const [wcId, k] of this.keyWaits) if (k.id === Number(id) && k.w === w) { this.keyDone(wcId, 'cancel'); return; }
    const p = this.pkPending.get(Number(id));
    if (!p || p.w !== w) return;
    this.pkPending.delete(p.id);
    if (w.overlayKind === 'passkey') w.hideOverlay();
    const deny = (message = 'The operation either timed out or was not allowed.') => p.resolve({ error: 'NotAllowedError', message });
    if (decision === 'key') return p.resolve({ native: true }); // the page uses a security key instead
    if (decision !== 'ok') return deny();
    if (p.kind === 'get' && !p.accounts.some((a) => a.id === account)) return deny();
    const check = await this.verifyPerson(w, p.kind === 'create' ? `save a passkey for ${p.rpId}` : `sign in to ${p.rpId} with a passkey`);
    if (!check.ok) return deny('Lumio couldn’t confirm it’s you.');
    // Still the same page?
    const wc = webContents.fromId(p.wcId);
    let now = null;
    try { now = wc && !wc.isDestroyed() ? new URL(wc.mainFrame.url).origin : null; } catch { /* gone */ }
    if (now !== p.origin) return deny('The page changed.');
    try {
      const credential = p.kind === 'create'
        ? this.passkeys.create(p.pk, p.origin, { verified: check.verified })
        : this.passkeys.assert(p.pk, p.origin, account, { verified: check.verified });
      p.resolve({ credential });
      if (p.kind === 'create') this.toast(w, `Passkey saved for ${p.rpId}`);
    } catch (err) {
      p.resolve({ error: err.name || 'NotAllowedError', message: err.message });
    }
  }

  // User verification for passkeys: every time (no 3-minute unlock).
  async verifyPerson(w, reason) {
    const testAuth = process.env.LUMIO_TEST && process.env.LUMIO_TEST_AUTH;
    if (testAuth) return { ok: testAuth === 'allow', verified: testAuth === 'allow' };
    if (process.platform === 'darwin' && this.helper?.available()) {
      const r = await this.helper.request('authenticate', { reason }, 120000).catch(() => null);
      if (r?.unavailable) return { ok: await this.confirmPasskey(w), verified: false };
      return { ok: !!r?.authenticated, verified: !!r?.authenticated };
    }
    if (process.platform === 'win32') {
      const r = await windowsHello(reason);
      if (r === 'unavailable') return { ok: await this.confirmPasskey(w), verified: false };
      return { ok: r === 'verified', verified: r === 'verified' };
    }
    return { ok: await this.confirmPasskey(w), verified: false };
  }

  async confirmPasskey(w) {
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'question', buttons: ['Continue', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'Use a passkey without Touch ID?',
      detail: 'This computer has no Touch ID, Windows Hello or password check that Lumio can use.',
    });
    return response === 0;
  }

  // ------------------------------------------------------------ manager page
  pageState() {
    return {
      available: this.store.available(),
      entries: this.store.list(),
      passkeys: this.passkeys.list(),
      never: this.store.never(),
      offer: this.settings.settings.offerPasswords !== false,
      autofill: this.settings.settings.autofillPasswords !== false,
      unlocked: Date.now() < this.authUntil,
      platform: process.platform,
    };
  }

  async reveal(w, id) {
    if (!(await this.authorize(w, 'show a saved password'))) return { ok: false };
    return { ok: true, password: this.store.secret(id), note: this.store.note(id) };
  }

  async copy(w, id) {
    if (!(await this.authorize(w, 'copy a saved password'))) return { ok: false };
    const password = this.store.secret(id);
    if (password == null) return { ok: false };
    clipboard.writeText(password);
    // Clear it again after a minute if nothing else was copied since.
    setTimeout(() => { if (clipboard.readText() === password) clipboard.clear(); }, 60_000).unref?.();
    return { ok: true };
  }

  async edit(w, id, patch) {
    if (!(await this.authorize(w, 'edit a saved password'))) return { ok: false };
    return { ok: this.store.update(id, patch || {}) };
  }

  add(entry) {
    try { return { ok: true, id: this.store.save(entry || {}) }; } catch (err) { return { ok: false, error: err.message }; }
  }

  async importFile(w) {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
      properties: ['openFile'],
      filters: [{ name: 'Passwords CSV', extensions: ['csv'] }],
      message: 'Choose a passwords CSV exported from Chrome, Edge, Brave, 1Password or Bitwarden',
    });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const text = fs.readFileSync(filePaths[0], 'utf8');
      return { ok: true, ...this.store.importCsv(text) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async exportFile(w) {
    if (!(await this.authorize(w, 'export your saved passwords'))) return { ok: false };
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'warning', buttons: ['Export', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Export passwords?',
      detail: 'The file will contain your passwords in plain text. Anyone who can open it can read them. Delete it when you’re done.',
    });
    if (response !== 0) return { ok: false, canceled: true };
    const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
      defaultPath: path.join(require('electron').app.getPath('downloads'), 'Lumio Passwords.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, this.store.exportCsv(), { mode: 0o600 });
    return { ok: true, count: this.store.entries.length };
  }
}

module.exports = { PasswordManager };
