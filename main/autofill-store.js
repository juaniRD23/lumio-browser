// Saved addresses, payment cards and form entries (main/autofill.js fills
// forms with them). Encrypted with safeStorage, like saved passwords:
//  - an address is one encrypted blob (names, streets and phone numbers are
//    personal);
//  - a card's number is encrypted on its own. Its last 4 digits, brand,
//    expiry and name stay readable so Settings and the dropdown can list it.
//    The security code (CVC) is never stored;
//  - form entries (what was typed in ordinary text fields) are encrypted too.
// Nothing is written in plain text: without encryption, saving is refused.
const crypto = require('crypto');
const { JsonFile } = require('./store');

const ADDRESS_FIELDS = ['name', 'organization', 'street', 'city', 'state', 'zip', 'country', 'phone', 'email'];
const ADDRESS_MAX = { name: 200, organization: 200, street: 400, city: 100, state: 100, zip: 20, country: 100, phone: 40, email: 200 };
const ADDRESSES_MAX = 100;
const CARDS_MAX = 50;
const ENTRY_MAX = 200; // characters in one form entry
const ENTRIES_PER_FIELD = 40;
const ENTRIES_MAX = 3000;
const ENTRY_DAYS = 400; // entries not used for about 13 months are forgotten

// ---------------------------------------------------------------- cards
const digits = (v) => String(v ?? '').replace(/\D/g, '');

function luhn(number) {
  const n = digits(number);
  if (n.length < 12 || n.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function cardBrand(number) {
  const n = digits(number);
  const p4 = Number(n.slice(0, 4));
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || (p4 >= 2221 && p4 <= 2720)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(n)) return 'discover';
  if (p4 >= 3528 && p4 <= 3589) return 'jcb';
  if (/^3(0[0-5]|[689])/.test(n)) return 'diners';
  if (/^62/.test(n)) return 'unionpay';
  return 'card';
}
const BRAND_NAMES = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay', card: 'Card' };
const brandName = (brand) => BRAND_NAMES[brand] || 'Card';

// A month (1-12) and a four-digit year, or null.
function expiry(month, year) {
  const m = Number(month);
  let y = Number(year);
  if (y >= 0 && y < 100) y += 2000;
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y < 2000 || y > 2100) return null;
  return { expMonth: m, expYear: y };
}
const isExpired = (c, now = new Date()) => c.expYear < now.getFullYear() || (c.expYear === now.getFullYear() && c.expMonth < now.getMonth() + 1);

// What a page or the person typed for a card, checked: a real card number
// (Luhn) and, when given, a real expiry. Never a security code.
function cleanCard({ number, name = '', nickname = '', expMonth, expYear } = {}) {
  const n = digits(number);
  if (!luhn(n)) return null;
  const exp = expMonth || expYear ? expiry(expMonth, expYear) : null;
  return { number: n, name: String(name || '').trim().slice(0, 100), nickname: String(nickname || '').trim().slice(0, 60), expMonth: exp?.expMonth || null, expYear: exp?.expYear || null };
}

// ---------------------------------------------------------------- addresses
function cleanAddress(fields = {}) {
  const out = {};
  for (const k of ADDRESS_FIELDS) {
    const v = typeof fields[k] === 'string' ? fields[k] : fields[k] == null ? '' : String(fields[k]);
    // Streets keep their line breaks; everything else is one line.
    out[k] = (k === 'street' ? v.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n') : v.replace(/\s+/g, ' ').trim()).slice(0, ADDRESS_MAX[k]);
  }
  return out;
}
const filled = (a) => ADDRESS_FIELDS.filter((k) => a[k]);
// Enough of an address to be worth saving: a street, or a city with a ZIP code.
const isAddress = (a) => filled(a).length >= 3 && (!!a.street || (!!a.city && !!a.zip));

// Comparing what a form sent (b) with what's saved (a): case, accents,
// punctuation and phone formatting don't count, and a form with fewer street
// lines (no apartment field) still matches.
const norm = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9@+]+/g, ' ').trim();
function sameValue(field, a, b) {
  if (field === 'phone') { const x = digits(a).slice(-10); const y = digits(b).slice(-10); return !!x && x === y; }
  if (field === 'street') { const saved = String(a || '').split('\n').map(norm); return String(b || '').split('\n').map(norm).every((l, i) => l === saved[i]); }
  return norm(a) === norm(b);
}

// One line for lists: "123 Main St, Miami, FL 33101".
function addressSummary(a) {
  const place = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [String(a.street || '').split('\n')[0], place].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------- form entries
// A field's name for remembering what was typed in it ("email", "city").
const fieldKey = (name) => String(name || '').toLowerCase().trim().slice(0, 80);
// Values never remembered: card numbers and US Social Security numbers,
// even when a site puts them in an ordinary field.
function sensitiveValue(value) {
  const v = String(value || '');
  const compact = v.replace(/[\s-]/g, '');
  if (/^\d{12,19}$/.test(compact) && luhn(compact)) return true;
  return /^\d{3}-?\d{2}-?\d{4}$/.test(v.trim());
}

class AutofillStore {
  constructor(dir, safeStorage) {
    this.safe = safeStorage;
    this.file = new JsonFile(dir, 'autofill.json', { version: 1, addresses: [], cards: [], never: { address: [], card: [] } });
    const d = this.file.data;
    if (!Array.isArray(d.addresses) || !Array.isArray(d.cards)) this.file.data = { version: 1, addresses: [], cards: [], never: { address: [], card: [] } };
    this.file.data.never ||= { address: [], card: [] };
    this.historyFile = new JsonFile(dir, 'form-history.json', { version: 1, entries: [] });
    if (!Array.isArray(this.historyFile.data.entries)) this.historyFile.data = { version: 1, entries: [] };
    this.plain = new Map(); // entry id -> decrypted value, so typing doesn't decrypt every entry each time
  }

  available() { return !!this.safe?.isEncryptionAvailable(); }
  enc(text) { return this.safe.encryptString(String(text)).toString('base64'); }
  dec(b64) { try { return this.safe.decryptString(Buffer.from(b64, 'base64')); } catch { return null; } }
  need() { if (!this.available()) throw new Error('Encryption isn’t available on this system, so Lumio can’t save this.'); }

  // ---------------------------------------------------------------- addresses
  get addressEntries() { return this.file.data.addresses; }
  // An address with its fields (decrypted), or null.
  address(id) {
    const e = this.addressEntries.find((x) => x.id === id);
    if (!e) return null;
    let fields = null;
    try { fields = JSON.parse(this.dec(e.data) || 'null'); } catch { /* unreadable */ }
    return fields ? { id: e.id, ...cleanAddress(fields), created: e.created, updated: e.updated, lastUsed: e.lastUsed || null, uses: e.uses || 0 } : null;
  }
  // Most used first, like the dropdown shows them.
  addresses() {
    return this.addressEntries.map((e) => this.address(e.id)).filter(Boolean)
      .sort((a, b) => (b.uses - a.uses) || ((b.lastUsed || b.updated) - (a.lastUsed || a.updated)));
  }

  saveAddress(fields, id = null) {
    this.need();
    const a = cleanAddress(fields);
    if (!filled(a).length) throw new Error('Fill in at least one field.');
    const now = Date.now();
    const existing = id && this.addressEntries.find((e) => e.id === id);
    if (existing) {
      existing.data = this.enc(JSON.stringify(a));
      existing.updated = now;
    } else {
      if (this.addressEntries.length >= ADDRESSES_MAX) throw new Error(`Lumio keeps up to ${ADDRESSES_MAX} addresses.`);
      id = crypto.randomUUID();
      this.addressEntries.push({ id, data: this.enc(JSON.stringify(a)), created: now, updated: now, lastUsed: null, uses: 0 });
    }
    this.file.save();
    return id;
  }

  removeAddress(id) {
    const before = this.addressEntries.length;
    this.file.data.addresses = this.addressEntries.filter((e) => e.id !== id);
    this.file.save(true);
    return this.addressEntries.length < before;
  }

  markAddressUsed(id) {
    const e = this.addressEntries.find((x) => x.id === id);
    if (e) { e.lastUsed = Date.now(); e.uses = (e.uses || 0) + 1; this.file.save(); }
  }

  // What an address a form sent should lead to: nothing (it's saved
  // already), an update of the same place with new details, or a new one.
  classifyAddress(fields) {
    const a = cleanAddress(fields);
    if (!isAddress(a)) return { action: 'none' };
    const keys = filled(a);
    const saved = this.addresses();
    const known = saved.find((s) => keys.every((k) => s[k] && sameValue(k, s[k], a[k])));
    if (known) return { action: 'none', id: known.id };
    const place = saved.find((s) => a.street && s.street && sameValue('street', s.street.split('\n')[0], a.street.split('\n')[0]) && (!a.zip || !s.zip || sameValue('zip', s.zip, a.zip)));
    if (place) {
      const merged = { ...place };
      for (const k of keys) merged[k] = a[k];
      return { action: 'update', id: place.id, fields: cleanAddress(merged) };
    }
    return { action: 'save', fields: a };
  }

  // ---------------------------------------------------------------- cards
  get cardEntries() { return this.file.data.cards; }
  // What Settings and the dropdown may see: never the number.
  cards() {
    return this.cardEntries.map((c) => ({
      id: c.id, brand: c.brand, brandName: brandName(c.brand), last4: c.last4, name: c.name || '', nickname: c.nickname || '',
      expMonth: c.expMonth || null, expYear: c.expYear || null, expired: !!(c.expYear && isExpired(c)),
      created: c.created, updated: c.updated, lastUsed: c.lastUsed || null, uses: c.uses || 0,
    })).sort((a, b) => (b.uses - a.uses) || ((b.lastUsed || b.updated) - (a.lastUsed || a.updated)));
  }
  card(id) { return this.cards().find((c) => c.id === id) || null; }
  cardNumber(id) { const c = this.cardEntries.find((x) => x.id === id); return c ? this.dec(c.number) : null; }
  cardByNumber(number) {
    const n = digits(number);
    return this.cardEntries.find((c) => c.last4 === n.slice(-4) && this.dec(c.number) === n) || null;
  }

  // Adds a card, or changes one (`id`). Editing without a number keeps the old one.
  saveCard(input, id = null) {
    this.need();
    const existing = id ? this.cardEntries.find((c) => c.id === id) : null;
    if (id && !existing) throw new Error('That card isn’t saved anymore.');
    const number = digits(input?.number) || (existing ? this.dec(existing.number) : '');
    const c = cleanCard({ ...input, number });
    if (!c) throw new Error('That card number isn’t valid. Check it and try again.');
    if ((input?.expMonth || input?.expYear) && !c.expMonth) throw new Error('That expiry date isn’t valid.');
    const same = this.cardByNumber(c.number);
    if (same && same.id !== id) throw new Error(`That card is already saved (${brandName(same.brand)} ending in ${same.last4}).`);
    const now = Date.now();
    const fields = { number: this.enc(c.number), last4: c.number.slice(-4), brand: cardBrand(c.number), name: c.name, nickname: c.nickname, expMonth: c.expMonth, expYear: c.expYear, updated: now };
    if (existing) Object.assign(existing, fields);
    else {
      if (this.cardEntries.length >= CARDS_MAX) throw new Error(`Lumio keeps up to ${CARDS_MAX} cards.`);
      id = crypto.randomUUID();
      this.cardEntries.push({ id, ...fields, created: now, lastUsed: null, uses: 0 });
    }
    this.file.save();
    return id;
  }

  removeCard(id) {
    const before = this.cardEntries.length;
    this.file.data.cards = this.cardEntries.filter((c) => c.id !== id);
    this.file.save(true);
    return this.cardEntries.length < before;
  }

  markCardUsed(id) {
    const c = this.cardEntries.find((x) => x.id === id);
    if (c) { c.lastUsed = Date.now(); c.uses = (c.uses || 0) + 1; this.file.save(); }
  }

  // A card a checkout form sent: nothing to do, an update (new expiry or
  // name), or a new card.
  classifyCard(input) {
    const c = cleanCard(input);
    if (!c) return { action: 'none' };
    const same = this.cardByNumber(c.number);
    if (!same) return { action: 'save', card: c };
    const changed = (c.expYear && (c.expYear !== same.expYear || c.expMonth !== same.expMonth)) || (c.name && c.name !== same.name);
    return changed ? { action: 'update', id: same.id, card: { ...c, name: c.name || same.name, nickname: same.nickname } } : { action: 'none', id: same.id };
  }

  // ---------------------------------------------------------------- "never for this site"
  never(kind) { return [...(this.file.data.never[kind] || [])]; }
  isNever(kind, site) { return !!site && (this.file.data.never[kind] || []).includes(site); }
  addNever(kind, site) {
    if (!site || !['address', 'card'].includes(kind)) return;
    this.file.data.never[kind] = [...new Set([...(this.file.data.never[kind] || []), site])].slice(-500);
    this.file.save();
  }
  removeNever(kind, site) {
    if (!this.file.data.never[kind]) return;
    this.file.data.never[kind] = this.file.data.never[kind].filter((s) => s !== site);
    this.file.save();
  }

  // ---------------------------------------------------------------- form entries
  get entries() { return this.historyFile.data.entries; }
  value(e) {
    if (!this.plain.has(e.id)) this.plain.set(e.id, this.dec(e.v));
    return this.plain.get(e.id);
  }

  // Remembers what was typed in ordinary fields: [{ key, value }].
  recordEntries(list) {
    if (!this.available() || !Array.isArray(list)) return 0;
    const now = Date.now();
    let n = 0;
    for (const item of list) {
      const key = fieldKey(item?.key);
      const value = String(item?.value ?? '').trim();
      if (!key || value.length < 2 || value.length > ENTRY_MAX || sensitiveValue(value)) continue;
      const same = this.entries.find((e) => e.k === key && this.value(e) === value);
      if (same) { same.n = (same.n || 1) + 1; same.t = now; n++; continue; }
      const e = { id: crypto.randomUUID(), k: key, v: this.enc(value), n: 1, t: now };
      this.plain.set(e.id, value);
      this.entries.push(e);
      n++;
    }
    if (n) this.pruneEntries(now);
    return n;
  }

  // Old entries go, then the least used beyond the limits.
  pruneEntries(now = Date.now()) {
    const cutoff = now - ENTRY_DAYS * 864e5;
    let list = this.entries.filter((e) => e.t >= cutoff);
    const rank = (a, b) => (b.n - a.n) || (b.t - a.t);
    const perField = new Map();
    for (const e of list.slice().sort(rank)) { if (!perField.has(e.k)) perField.set(e.k, []); perField.get(e.k).push(e); }
    list = [...perField.values()].flatMap((l) => l.slice(0, ENTRIES_PER_FIELD)).sort(rank).slice(0, ENTRIES_MAX);
    const keep = new Set(list.map((e) => e.id));
    for (const id of this.plain.keys()) if (!keep.has(id)) this.plain.delete(id);
    this.historyFile.data.entries = this.entries.filter((e) => keep.has(e.id));
    this.historyFile.save();
  }

  // Earlier entries for a field that start with what's typed (not what's
  // typed exactly), most used first.
  suggestEntries(key, prefix = '', limit = 6) {
    key = fieldKey(key);
    const p = String(prefix || '').trim().toLowerCase();
    if (!key || !this.available()) return [];
    return this.entries.filter((e) => e.k === key)
      .map((e) => ({ e, value: this.value(e) }))
      .filter(({ value }) => value && value.toLowerCase().startsWith(p) && value.toLowerCase() !== p)
      .sort((a, b) => (b.e.n - a.e.n) || (b.e.t - a.e.t))
      .slice(0, limit)
      .map(({ e, value }) => ({ id: e.id, value }));
  }

  removeEntry(id) {
    const before = this.entries.length;
    this.historyFile.data.entries = this.entries.filter((e) => e.id !== id);
    this.plain.delete(id);
    this.historyFile.save(true);
    return this.entries.length < before;
  }

  clearEntries() {
    const n = this.entries.length;
    this.historyFile.data.entries = [];
    this.plain.clear();
    this.historyFile.save(true);
    return n;
  }

  // ---------------------------------------------------------------- Lumio Sync
  // Records for sync (decrypted here only to be encrypted again by the sync
  // engine), and other devices' changes applied here.
  addressRecord(id) {
    const a = this.address(id);
    if (!a) return null;
    const { id: _id, lastUsed, uses, ...rest } = a;
    return rest;
  }
  cardRecord(id) {
    const c = this.cardEntries.find((x) => x.id === id);
    const number = c && this.dec(c.number);
    return number ? { number, name: c.name || '', nickname: c.nickname || '', expMonth: c.expMonth || null, expYear: c.expYear || null, created: c.created, updated: c.updated } : null;
  }

  applySyncedAddresses(changes) {
    if (!this.available()) return changes.map((c) => c.key);
    const rejected = [];
    for (const { key, record: r } of changes) {
      const i = this.addressEntries.findIndex((e) => e.id === key);
      if (!r) { if (i >= 0) this.addressEntries.splice(i, 1); continue; }
      const a = cleanAddress(r);
      if (!filled(a).length) { rejected.push(key); continue; }
      const fields = { data: this.enc(JSON.stringify(a)), created: Number(r.created) || Date.now(), updated: Number(r.updated) || Date.now() };
      if (i >= 0) { Object.assign(this.addressEntries[i], fields); continue; }
      // The same address saved separately on two devices: the newer one stays.
      const dup = this.addresses().find((s) => ADDRESS_FIELDS.every((k) => sameValue(k, s[k], a[k])));
      if (dup) {
        if ((dup.updated || 0) > fields.updated) { rejected.push(key); continue; }
        this.file.data.addresses = this.addressEntries.filter((e) => e.id !== dup.id);
      }
      this.addressEntries.push({ id: key, ...fields, lastUsed: null, uses: 0 });
    }
    this.file.save(true);
    return rejected;
  }

  applySyncedCards(changes) {
    if (!this.available()) return changes.map((c) => c.key);
    const rejected = [];
    for (const { key, record: r } of changes) {
      const i = this.cardEntries.findIndex((c) => c.id === key);
      if (!r) { if (i >= 0) this.cardEntries.splice(i, 1); continue; }
      const c = cleanCard(r);
      if (!c) { rejected.push(key); continue; }
      const fields = { number: this.enc(c.number), last4: c.number.slice(-4), brand: cardBrand(c.number), name: c.name, nickname: c.nickname, expMonth: c.expMonth, expYear: c.expYear, created: Number(r.created) || Date.now(), updated: Number(r.updated) || Date.now() };
      if (i >= 0) { Object.assign(this.cardEntries[i], fields); continue; }
      const dup = this.cardByNumber(c.number);
      if (dup) {
        if ((dup.updated || 0) > fields.updated) { rejected.push(key); continue; }
        this.file.data.cards = this.cardEntries.filter((x) => x.id !== dup.id);
      }
      this.cardEntries.push({ id: key, ...fields, lastUsed: null, uses: 0 });
    }
    this.file.save(true);
    return rejected;
  }
}

module.exports = { AutofillStore, ADDRESS_FIELDS, luhn, cardBrand, brandName, cleanCard, cleanAddress, isAddress, addressSummary, sensitiveValue, fieldKey, isExpired };
