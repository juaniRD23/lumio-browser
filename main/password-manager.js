// Connects saved passwords (passwords.js) to tabs and the browser UI:
//  - after a sign-in the person typed, offer to save or update it;
//  - under a sign-in field they clicked, list saved accounts (or suggest a
//    strong password on sign-up forms) in Lumio's own dropdown;
//  - fill only the page that asked, only after a choice, and only while it's
//    still on the same site;
//  - confirm who they are (Touch ID / Mac password, Windows Hello) before
//    showing, copying or exporting passwords.
// Page messages come from the isolated tab preload (preload/internal.js).
const { ipcMain, clipboard, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { PasswordStore, generatePassword, siteKey } = require('./passwords');
const { windowsHello } = require('./win/hello');

const AUTH_MS = 3 * 60 * 1000;
const PROMPT_MS = 10 * 60 * 1000;

class PasswordManager {
  constructor({ dir, safeStorage, settings, helper, findTab, toast }) {
    this.store = new PasswordStore(dir, safeStorage);
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

  // ------------------------------------------------------------ manager page
  pageState() {
    return {
      available: this.store.available(),
      entries: this.store.list(),
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
