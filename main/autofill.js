// Address, payment card and form-entry autofill. The page side
// (preload/autofill.js, a session preload in every tab) finds the fields; this
// side keeps the data (autofill-store.js), draws Lumio's dropdown under a
// field and the "Save address?" / "Save card?" bubble after a form is sent
// (both in the window's overlay, renderer/ui/overlay-autofill.js), and runs
// Settings › Addresses and Payment methods.
//  - Nothing is filled until the person picks something in Lumio's dropdown,
//    and only into the page (and site) that asked.
//  - A card is filled only after the person confirms it's them (Touch ID or
//    the Mac password, Windows Hello, or a dialog where neither exists). The
//    security code (CVC) is never saved. Card numbers never go to Lumio AI or
//    any server: the AI can't open card suggestions, and Lumio Sync carries
//    cards only encrypted with the account's sync key (docs/sync-managed.md),
//    and only when the person turns it on.
//  - Incognito windows can fill saved addresses and cards, but never save new
//    ones or remember form entries.
const { ipcMain, dialog, systemPreferences } = require('electron');
const crypto = require('crypto');
const path = require('path');
const { AutofillStore, brandName, cardBrand, addressSummary, cleanAddress, ADDRESS_FIELDS } = require('./autofill-store');
const { windowsHello } = require('./win/hello');

const PRELOAD = path.join(__dirname, '..', 'preload', 'autofill.js');
const PROMPT_MS = 10 * 60 * 1000;
const ASKED_MS = 30 * 60 * 1000; // the same address or card isn't offered again for a while after an answer
const SETTINGS_KEYS = ['autofillAddresses', 'autofillCards', 'formHistory'];
// Questions Lumio is asking in the overlay: autofill never covers them (menus it may).
const QUESTIONS = new Set(['passkey', 'pwsave', 'screenshare', 'update', 'feedback', 'formsave', 'ntp-override']);
const FIELDS = new Set(['name', 'given', 'middle', 'family', 'organization', 'street', 'line1', 'line2', 'line3', 'city', 'state', 'zip', 'country', 'phone', 'email']);
// Dropdown sizes (renderer/ui/overlay-autofill.css): rows, the footer, and
// the view's padding around the card.
const ROW = 48;
const ROW_ONE = 38;
const FOOT = 37;
const CHROME = 2 + 22 + 12 + 2;

// The page's origin, but only for a tab's own top frame on http(s).
function originOf(e) {
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame) return null;
  try {
    const u = new URL(frame.url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}
// Cards only on https, or on this computer (local development).
function secure(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
  } catch { return false; }
}
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return ''; } };
const site = (origin) => { try { const u = new URL(origin); return `${u.protocol}//${u.hostname.replace(/^www\./, '')}${u.port ? ':' + u.port : ''}`; } catch { return null; } };
const exp = (c) => (c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(2)}` : '');
const cardLabel = (c) => `${brandName(c.brand)} •••• ${c.last4}`;

class AutofillManager {
  constructor({ dir, safeStorage, settings, helper, findTab, toast, openPage }) {
    this.store = new AutofillStore(dir, safeStorage);
    this.settings = settings; // the app Store (for the on/off switches)
    this.helper = helper; // macOS helper (Touch ID / Mac password)
    this.findTab = findTab; // (webContents) -> { w, tab } | null
    this.toast = toast; // (w, text)
    this.openPage = openPage; // (url) opens a lumio:// page
    this.menus = new Map(); // webContents id -> the dropdown under a field there
    this.pending = new Map(); // prompt id -> { what, action, origin, data, id, w, tabId, at }
    this.asked = new Map(); // what was just answered -> when
    this.hooked = new WeakSet(); // tabs whose dropdown is forgotten when they close
    let next = 1;
    this.nextId = () => next++;
  }

  on(key) { return this.settings.settings[key] !== false; }

  // Pages' messages (preload/autofill.js) come once for every profile:
  // pick(webContents) is the manager of the tab that sent one (null: none).
  static registerPages(pick) {
    const on = (channel, fn) => ipcMain.on(channel, (e, ...args) => { const m = pick(e.sender); if (m) fn(m, e, ...args); });
    const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => { const m = pick(e.sender); return m ? fn(m, e, ...args) : null; });
    handle('af:query', (m, e, q) => m.query(e, q || {}));
    on('af:select', (m, e, d) => m.select(e.sender.id, d?.index));
    // Enter in the field picks only what the person can see highlighted.
    on('af:pick', (m, e, d) => { if (originOf(e) && m.visible(e.sender.id)) m.pick(e.sender, d?.index); else m.close(e.sender.id); });
    handle('af:remove', (m, e, d) => m.remove(e.sender.id, d?.index));
    on('af:hide', (m, e) => m.close(e.sender.id));
    on('af:captured', (m, e, data) => m.captured(e, data));
  }

  // on/internalHandle: the window's and Settings' messages (main.js routes
  // them to the sender's profile). pages: false when registerPages() already
  // routes the pages' messages (several profiles).
  register({ on, internalHandle, pages = true }) {
    if (pages) AutofillManager.registerPages(() => this);

    // The overlay (a click in the dropdown or the bubble).
    const menuWc = (w) => { const wc = w.tabs.active?.view?.webContents; return wc && this.menus.get(wc.id)?.w === w ? wc : null; };
    on('autofill:pick', (w, d) => { const wc = menuWc(w); if (wc) this.pick(wc, d?.index); });
    on('autofill:remove', (w, d) => { const wc = menuWc(w); if (wc) this.remove(wc.id, d?.index); });
    on('autofill:manage', (w, what) => { this.closeAll(w); this.openPage(what === 'cards' ? 'lumio://settings/#payments' : 'lumio://settings/#addresses'); });
    on('autofill:decide', (w, d) => this.decide(w, d || {}));

    // Settings › Addresses, Payment methods and form entries.
    const reply = (fn) => { try { return { ok: true, ...fn() }; } catch (err) { return { ok: false, error: err.message }; } };
    internalHandle('page:autofill', ['settings'], () => this.pageState());
    internalHandle('page:autofill-set', ['settings'], (_ctx, key, value) => { if (SETTINGS_KEYS.includes(key)) this.settings.setSetting(key, !!value); return this.pageState(); });
    internalHandle('page:address-save', ['settings'], (_ctx, fields, id) => reply(() => ({ id: this.store.saveAddress(fields || {}, id ? String(id) : null) })));
    internalHandle('page:address-delete', ['settings'], (_ctx, id) => ({ ok: this.store.removeAddress(String(id)) }));
    internalHandle('page:card-save', ['settings'], (_ctx, fields, id) => reply(() => ({ id: this.store.saveCard(fields || {}, id ? String(id) : null) })));
    internalHandle('page:card-delete', ['settings'], (_ctx, id) => ({ ok: this.store.removeCard(String(id)) }));
    internalHandle('page:card-reveal', ['settings'], async ({ w }, id) => {
      const c = this.store.card(String(id));
      if (!c || !(await this.verify(w, `show your ${cardLabel(c).replace(' •••• ', ' card ending in ')}`))) return { ok: false };
      return { ok: true, number: this.store.cardNumber(c.id) };
    });
    internalHandle('page:form-history-clear', ['settings'], () => ({ ok: true, count: this.store.clearEntries() }));
    internalHandle('page:autofill-never-remove', ['settings'], (_ctx, kind, where) => { this.store.removeNever(String(kind), String(where)); return this.pageState(); });
  }

  pageState() {
    return {
      available: this.store.available(),
      addresses: this.store.addresses().map((a) => ({ ...a, summary: addressSummary(a) })),
      cards: this.store.cards(),
      entries: this.store.entries.length,
      never: { address: this.store.never('address'), card: this.store.never('card') },
      autofillAddresses: this.on('autofillAddresses'),
      autofillCards: this.on('autofillCards'),
      formHistory: this.on('formHistory'),
      platform: process.platform,
    };
  }

  // ---------------------------------------------------------------- the dropdown under a field
  // A field was clicked or typed in: what Lumio can offer there, shown in its
  // dropdown. Answers how many items it shows (0 hides it).
  query(e, { mode, field, key, prefix = '', rect } = {}) {
    const origin = originOf(e);
    const found = this.findTab(e.sender);
    const none = () => { this.close(e.sender.id); return { count: 0 }; };
    if (!origin || !found || !rect || ![rect.x, rect.top, rect.bottom, rect.width].every(Number.isFinite) || !this.store.available()) return none();
    const { w, tab } = found;
    if (tab.id !== w.tabs.activeId || !tab.view) return none();
    prefix = String(prefix || '').slice(0, 200);
    let items = [];
    let what = mode;
    if (mode === 'address' && FIELDS.has(field) && this.on('autofillAddresses')) items = this.addressItems(field, prefix);
    else if (mode === 'card' && /^cc-/.test(String(field)) && this.on('autofillCards') && secure(origin) && !w.ai?.isRunning()) items = this.cardItems();
    // No saved address for what's typed: earlier entries for the field instead.
    if (!items.length && key && mode !== 'card' && this.on('formHistory') && !w.incognito) { items = this.historyItems(key, prefix); what = 'history'; }
    if (!items.length) return none();
    if (QUESTIONS.has(w.overlayKind)) return none();
    if (!this.hooked.has(e.sender)) {
      this.hooked.add(e.sender);
      const id = e.sender.id;
      e.sender.once('destroyed', () => this.menus.delete(id));
    }
    this.menus.set(e.sender.id, { w, wc: e.sender, tabId: tab.id, origin, mode: what, items, selected: -1, rect, zoom: e.sender.getZoomFactor() });
    this.show(e.sender.id);
    return { count: items.length };
  }

  addressItems(field, prefix) {
    const p = prefix.trim().toLowerCase();
    const value = (a) => {
      const parts = a.name.split(/\s+/);
      if (field === 'given') return parts.length > 1 ? parts.slice(0, -1).join(' ') : a.name;
      if (field === 'family') return parts.length > 1 ? parts.at(-1) : '';
      if (['street', 'line1', 'line2', 'line3'].includes(field)) return a.street.split('\n')[0];
      return field === 'middle' ? a.name : a[field] || '';
    };
    return this.store.addresses()
      .filter((a) => !p || value(a).toLowerCase().startsWith(p))
      .slice(0, 6)
      .map((a) => {
        const label = value(a) || a.name || a.street.split('\n')[0] || a.email;
        const sub = [a.name, addressSummary(a), a.email].filter((x) => x && x !== label)[0] || '';
        return { type: 'address', id: a.id, label, sub };
      });
  }

  cardItems() {
    return this.store.cards().filter((c) => !c.expired).slice(0, 6).map((c) => ({
      type: 'card', id: c.id, label: c.nickname ? `${c.nickname} · •••• ${c.last4}` : cardLabel(c), sub: [c.name, exp(c) && `Expires ${exp(c)}`].filter(Boolean).join(' · '),
    }));
  }

  historyItems(key, prefix) {
    return this.store.suggestEntries(key, prefix).map((x) => ({ type: 'history', id: x.id, label: x.value, removable: true }));
  }

  // Draws (or redraws) the dropdown under its field, or above it when there's no room below.
  show(wcId) {
    const m = this.menus.get(wcId);
    const tab = m && m.w.tabs.tabs.find((t) => t.id === m.tabId);
    if (!tab?.view || m.w.closed) return;
    const b = tab.view.getBounds();
    const z = m.zoom || 1;
    const rows = m.items.reduce((h, it) => h + (it.sub ? ROW : ROW_ONE), 0);
    const footer = m.mode === 'history' ? 0 : FOOT;
    const height = rows + footer + CHROME;
    const width = Math.max(300, Math.min(420, m.rect.width * z)) + 24;
    const [, winH] = m.w.win.getContentSize();
    let y = b.y + m.rect.bottom * z + 2;
    // The card sits 2px below the view's top and 22px above its bottom.
    if (y + height > winH - 4 && b.y + m.rect.top * z - height + 20 > b.y) y = b.y + m.rect.top * z - height + 20;
    m.w.showOverlay({ x: b.x + m.rect.x * z - 12, y, width, height }, this.payload(m));
  }

  payload(m) {
    return {
      kind: 'formfill',
      mode: m.mode,
      items: m.items.map(({ type, label, sub, removable }) => ({ type, label, sub: sub || '', removable: !!removable })),
      selected: m.selected,
      footer: m.mode === 'address' ? 'Manage addresses…' : m.mode === 'card' ? 'Manage payment methods…' : '',
    };
  }

  // Is this tab's dropdown on screen? (Switching tabs or another popup hides it.)
  visible(wcId) {
    const m = this.menus.get(wcId);
    return !!m && m.w.overlayKind === 'formfill' && m.w.tabs.activeId === m.tabId;
  }

  // Arrow keys in the field move the highlight.
  select(wcId, index) {
    const m = this.menus.get(wcId);
    if (!m || !Number.isInteger(index) || index < -1 || index >= m.items.length) return;
    if (!this.visible(wcId)) { this.close(wcId); return; }
    m.selected = index;
    m.w.overlay.webContents.send('overlay-data', this.payload(m));
  }

  close(wcId) {
    const m = this.menus.get(wcId);
    if (!m) return;
    this.menus.delete(wcId);
    if (m.w.overlayKind === 'formfill') m.w.hideOverlay();
    if (!m.wc.isDestroyed()) m.wc.mainFrame.send('af:closed'); // the page's arrow keys go back to the page
  }
  closeAll(w) {
    for (const [id, m] of this.menus) if (m.w === w) this.close(id);
  }

  // Shift+Delete (or the ✕) on an earlier entry forgets it. Answers how many items are left.
  remove(wcId, index) {
    const m = this.menus.get(wcId);
    const it = m?.items[index];
    if (!it) return { count: m?.items.length || 0 };
    if (it.type !== 'history') return { count: m.items.length };
    this.store.removeEntry(it.id);
    m.items.splice(index, 1);
    m.selected = Math.min(m.selected, m.items.length - 1);
    if (!m.items.length) { this.close(wcId); return { count: 0 }; }
    this.show(wcId);
    return { count: m.items.length };
  }

  // The person picked an item: fill that tab's page, if it's still the same site.
  async pick(wc, index) {
    const m = this.menus.get(wc.id);
    const it = m?.items[Number(index)];
    this.close(wc.id);
    if (!it || wc.isDestroyed()) return;
    const still = () => { try { return !wc.isDestroyed() && new URL(wc.mainFrame.url).origin === m.origin; } catch { return false; } };
    if (!still()) return;
    if (it.type === 'history') { wc.mainFrame.send('af:fill', { mode: 'history', value: it.label }); return; }
    if (it.type === 'address') {
      const a = this.store.address(it.id);
      if (!a) return;
      wc.mainFrame.send('af:fill', { mode: 'address', values: Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, a[k]])) });
      this.store.markAddressUsed(a.id);
      return;
    }
    const c = this.store.card(it.id);
    if (!c || m.w.ai?.isRunning()) return;
    if (!(await this.verify(m.w, `fill your ${brandName(c.brand)} card ending in ${c.last4}`))) return;
    const number = this.store.cardNumber(c.id);
    if (!number || !still()) return;
    wc.mainFrame.send('af:fill', { mode: 'card', values: { number, name: c.name, expMonth: c.expMonth, expYear: c.expYear } });
    this.store.markCardUsed(c.id);
  }

  // ---------------------------------------------------------------- confirming it's the person
  // Before a card number is filled or shown: every time, no unlocked period.
  async verify(w, reason) {
    const testAuth = process.env.LUMIO_TEST && process.env.LUMIO_TEST_AUTH;
    if (testAuth) return testAuth === 'allow';
    if (process.platform === 'darwin') {
      const r = this.helper?.available() ? await this.helper.request('authenticate', { reason }, 120000).catch(() => null) : null;
      if (r && !r.unavailable) return !!r.authenticated;
      // No helper: Touch ID straight from Electron, where the Mac has it.
      if (!r && systemPreferences.canPromptTouchID?.()) return systemPreferences.promptTouchID(reason).then(() => true, () => false);
    } else if (process.platform === 'win32') {
      const r = await windowsHello(reason);
      if (r !== 'unavailable') return r === 'verified';
    }
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'warning', buttons: ['Use card', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Use your saved card?',
      detail: 'This computer has no Touch ID, Windows Hello or password check that Lumio can use, so anyone using it can use your saved cards.',
    });
    return response === 0;
  }

  // ---------------------------------------------------------------- saving after a form is sent
  captured(e, data) {
    const origin = originOf(e);
    const found = this.findTab(e.sender);
    if (!origin || !found || !data || typeof data !== 'object' || !this.store.available()) return;
    const { w, tab } = found;
    if (w.incognito) return; // incognito never saves
    if (Array.isArray(data.history) && this.on('formHistory')) this.store.recordEntries(data.history.slice(0, 30));
    const where = site(origin);
    const prompts = [];
    if (data.card && typeof data.card === 'object' && this.on('autofillCards') && secure(origin) && !this.store.isNever('card', where)) {
      const k = this.store.classifyCard(data.card);
      if (k.action === 'none' && k.id) this.store.markCardUsed(k.id);
      else if (k.action !== 'none') prompts.push({ what: 'card', action: k.action, id: k.id, data: k.card });
    }
    if (data.address && typeof data.address === 'object' && this.on('autofillAddresses') && !this.store.isNever('address', where)) {
      const k = this.store.classifyAddress(data.address);
      if (k.action === 'none' && k.id) this.store.markAddressUsed(k.id);
      else if (k.action !== 'none') prompts.push({ what: 'address', action: k.action, id: k.id, data: k.fields });
    }
    const now = Date.now();
    for (const [k, t] of this.asked) if (now - t > ASKED_MS) this.asked.delete(k);
    for (const [id, p] of this.pending) if (now - p.at > PROMPT_MS) this.pending.delete(id); // card numbers don't linger
    const fresh = prompts.filter((p) => !this.asked.has(this.askKey(p)));
    if (!fresh.length) return;
    // One question per tab: newer ones replace older unanswered ones.
    for (const [id, p] of this.pending) if (p.w === w && p.tabId === tab.id) this.pending.delete(id);
    for (const p of fresh) this.pending.set(this.nextId(), { ...p, origin, w, tabId: tab.id, at: now });
    this.prompt(w);
  }

  // Remembers what was answered without keeping card numbers or addresses around.
  askKey(p) { return crypto.createHash('sha256').update(`${p.what}:${p.what === 'card' ? p.data.number : JSON.stringify(cleanAddress(p.data))}`).digest('hex'); }

  pendingFor(w, id) {
    const p = this.pending.get(id);
    if (!p || p.w !== w) return null;
    if (Date.now() - p.at > PROMPT_MS) { this.pending.delete(id); return null; }
    return p;
  }

  // Shows the next question for the window's tab, in the top corner of the page.
  prompt(w) {
    const tab = w.tabs.active;
    const entry = [...this.pending].find(([id, p]) => p.tabId === tab?.id && this.pendingFor(w, id));
    if (!entry || !tab?.view || w.closed) return;
    if (QUESTIONS.has(w.overlayKind)) return; // another question is showing: this one isn't asked
    const [id, p] = entry;
    const b = tab.view.getBounds();
    const width = 360;
    const lines = p.what === 'card'
      ? [cardLabel({ brand: cardBrand(p.data.number), last4: p.data.number.slice(-4) }), p.data.name, exp(p.data) && `Expires ${exp(p.data)}`].filter(Boolean)
      : [p.data.name, p.data.organization, ...String(p.data.street || '').split('\n'), [p.data.city, [p.data.state, p.data.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), p.data.country, p.data.phone, p.data.email].filter(Boolean);
    const auth = process.platform === 'darwin' ? 'Touch ID or your Mac password' : process.platform === 'win32' ? 'Windows Hello' : 'your OK';
    const note = p.what === 'card'
      ? `Lumio keeps it encrypted on this computer and asks for ${auth} before filling it. The security code is never saved.`
      : 'Lumio keeps it encrypted on this computer and offers it when you fill in a form.';
    this.closeAll(w);
    w.showOverlay(
      { x: b.x + b.width - width - 28, y: b.y + 4, width: width + 24, height: 190 + lines.length * 20 },
      { kind: 'formsave', prompt: { id, what: p.what, action: p.action, host: hostOf(p.origin), lines, note } },
    );
    // Keyboard people can answer right away (Enter saves, Esc says not now).
    if (w.win.isFocused()) w.overlay.webContents.focus();
  }

  decide(w, { id, decision } = {}) {
    const p = this.pendingFor(w, Number(id));
    if (w.overlayKind === 'formsave') w.hideOverlay();
    w.tabs.active?.view?.webContents.focus();
    if (!p) return;
    this.pending.delete(Number(id));
    this.asked.set(this.askKey(p), Date.now());
    try {
      if (decision === 'never') this.store.addNever(p.what, site(p.origin));
      else if (decision === 'save' && p.what === 'card') {
        this.store.saveCard(p.data, p.action === 'update' ? p.id : null);
        this.toast(w, p.action === 'update' ? 'Card updated' : 'Card saved');
      } else if (decision === 'save') {
        this.store.saveAddress(p.data, p.action === 'update' ? p.id : null);
        this.toast(w, p.action === 'update' ? 'Address updated' : 'Address saved');
      }
    } catch (err) {
      this.toast(w, err.message);
    }
    this.prompt(w); // a card and an address from the same checkout: ask about the next one
  }
}

// Every tab session (normal and incognito) gets the page side.
function attachAutofill(ses) {
  ses.registerPreloadScript({ type: 'frame', id: 'lumio-autofill', filePath: PRELOAD });
}

module.exports = { AutofillManager, attachAutofill };
