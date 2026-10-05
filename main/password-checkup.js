// Password Checkup (Passwords › Check passwords, and Settings › Safety
// check): which saved passwords appeared in a data breach, are used on more
// than one site, or are weak.
//
// Breaches come from Have I Been Pwned's Pwned Passwords range API with
// k-anonymity: Lumio sends only the first 5 characters of each password's
// SHA-1 hash and compares the hundreds of answers it gets back on this
// computer. Passwords, and full hashes, never leave it. Answers are padded
// (Add-Padding), so their size says nothing either.
//
// Results are kept per saved password (compromised or not, and when the
// password was last changed), never anything made from the password itself:
// changing a password makes its result stale until the next check.
const crypto = require('crypto');
const { JsonFile } = require('./store');

const API = 'https://api.pwnedpasswords.com/range/';

const sha1 = (text) => crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').toUpperCase();

// "SUFFIX:COUNT" lines; padding lines have a count of 0.
function parseRange(text) {
  const found = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const [suffix, count] = line.trim().split(':');
    const n = Number(count);
    if (/^[0-9A-F]{35}$/i.test(suffix || '') && n > 0) found.set(suffix.toUpperCase(), n);
  }
  return found;
}

class PasswordCheckup {
  // store: the saved passwords (main/passwords.js). fetchImpl(url, init).
  constructor({ store, dir, fetchImpl = (...a) => require('electron').net.fetch(...a), now = () => Date.now() }) {
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    this.file = new JsonFile(dir, 'password-checkup.json', { checked: 0, results: {} });
    this.running = null;
  }

  // Checks every saved password. Resolves with summary().
  run() {
    this.running ??= this.check().finally(() => { this.running = null; });
    return this.running;
  }

  async check() {
    const entries = this.store.entries;
    const byPrefix = new Map(); // prefix -> [{ id, suffix }]
    for (const e of entries) {
      const pw = this.store.secret(e.id);
      if (!pw) continue;
      const hash = sha1(pw);
      const list = byPrefix.get(hash.slice(0, 5)) || [];
      list.push({ id: e.id, suffix: hash.slice(5) });
      byPrefix.set(hash.slice(0, 5), list);
    }
    const results = {};
    const prefixes = [...byPrefix.keys()];
    let failed = 0;
    // A few at a time, to be polite to the service.
    for (let i = 0; i < prefixes.length; i += 4) {
      await Promise.all(prefixes.slice(i, i + 4).map(async (prefix) => {
        try {
          const res = await this.fetch(API + prefix, { headers: { 'Add-Padding': 'true' }, cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const found = parseRange(await res.text());
          for (const { id, suffix } of byPrefix.get(prefix)) results[id] = { compromised: found.has(suffix) };
        } catch { failed++; }
      }));
    }
    if (failed && failed === prefixes.length) return { ...this.summary(), error: 'Couldn’t check your passwords. Check your internet connection and try again.' };
    const updated = Object.fromEntries(entries.map((e) => [e.id, e.updated || e.created || 0]));
    const kept = this.file.data.results || {};
    this.file.data = {
      checked: this.now(),
      // Passwords that couldn't be checked this time keep their last result.
      results: Object.fromEntries(entries.filter((e) => results[e.id] || kept[e.id]).map((e) => [e.id, results[e.id] ? { ...results[e.id], updated: updated[e.id] } : kept[e.id]])),
    };
    this.file.save(true);
    return { ...this.summary(), ...(failed ? { error: 'Some passwords couldn’t be checked. Try again later.' } : {}) };
  }

  // Is this saved password known to be in a breach? (null: not checked
  // since it last changed.)
  compromised(entry) {
    const r = this.file.data.results?.[entry.id];
    if (!r || r.updated !== (entry.updated || entry.created || 0)) return null;
    return !!r.compromised;
  }

  // Every saved password's result, by id: true (in a breach), false, or null.
  flags() { return Object.fromEntries(this.store.entries.map((e) => [e.id, this.compromised(e)])); }

  // Counts for the Passwords page and Safety check. list: the page's entries
  // (with weak and reused, from main/passwords.js).
  summary(list = this.store.list()) {
    const flags = list.map((e) => this.compromised(this.store.get(e.id) || e));
    return {
      checked: this.file.data.checked || 0,
      total: list.length,
      compromised: flags.filter((f) => f === true).length,
      unchecked: flags.filter((f) => f === null).length,
      reused: list.filter((e) => e.reused).length,
      weak: list.filter((e) => e.weak).length,
    };
  }
}

module.exports = { PasswordCheckup, parseRange, sha1, API };
