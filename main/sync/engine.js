// Lumio Sync on this computer: keeps bookmarks (with folders), the reading
// list, saved tab groups, passwords, passkeys,
// addresses, cards (when turned on), history, chats, workflows, projects, settings and
// open tabs the same on every device signed in to the same Lumio account.
// Records are encrypted here (main/sync/crypto.js) before they leave; the
// server stores ciphertext.
//
// The account's sync key (docs/sync-managed.md): by default Lumio's server
// keeps it, and signing in is all this computer needs to get it. With the
// account's own passphrase it stays on the devices: a device that has it
// approves this one, or the person types the recovery key.
//
// How it works: each collection (main/sync/adapters.js) lists its records
// with a hash. The engine remembers the hash of every record as last synced;
// a different hash means it changed here and is uploaded, a missing record
// was deleted here. Other devices' changes come down by sequence number and
// are applied unless the same record also changed here (then this device's
// version wins and goes up). Runs a few seconds after any local change, and
// every minute.
const os = require('os');
const crypto = require('crypto');
const { JsonFile } = require('../store');
const C = require('./crypto');

const TYPES = ['bookmarks', 'passwords', 'passkeys', 'addresses', 'cards', 'history', 'chats', 'workflows', 'projects', 'settings', 'tabs'];
// Synced only after the person turns them on: card numbers stay on each computer by default.
const OFF_BY_DEFAULT = new Set(['cards']);
// Collections added after the first release of Lumio Sync. A server that
// doesn't know them yet refuses them; the rest still sync, and they're tried
// again in an hour.
const NEWER = new Set(['passkeys', 'addresses', 'cards']);
const RETRY_NEWER = 60 * 60 * 1000;
const BATCH = 100;
const EVERY = 60 * 1000;
const SOON = 4000;
const MAX_RECORD = 420 * 1024; // JSON, before encryption
const UPLOAD_EVERY = 10 * 60 * 1000; // a key Lumio doesn't keep yet is offered again after this
const KEY_WAIT = 10 * 60 * 1000; // Lumio's key routes said "too many requests" (their retry-after)
const BAD_KEY = 'The sync key from Lumio didn’t match. Lumio tries again in a minute.';
const TOO_MANY = 'Too many requests. Try again in a few minutes.';
const MODE_CHANGED = 'Paused to keep your sync key private: Lumio’s server says this account no longer uses your own passphrase, and this computer didn’t change that.';
const ALREADY_PASSPHRASE = 'This account already uses its own passphrase. Approve this computer from a device that has the key, or use your recovery key.';

const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

function deviceName() {
  if (process.platform === 'darwin') {
    try { return require('child_process').execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim().slice(0, 60); } catch { /* fall back */ }
  }
  return os.hostname().replace(/\.local$/i, '').replace(/[-_]+/g, ' ').slice(0, 60) || 'Computer';
}

class SyncEngine {
  constructor({ dir, store, account, adapters = [], onState = () => {}, onPairRequest = () => {} }) {
    this.store = store;
    this.account = account;
    this.adapters = new Map((adapters || []).map((a) => [a.name, a]));
    this.onState = onState;
    this.onPairRequest = onPairRequest; // a new device asks to join (show it to the person)
    this.file = new JsonFile(dir, 'sync-state.json', { owner: null, cursor: 0, records: {} });
    if (!this.store.settings.syncDeviceId) this.store.setSetting('syncDeviceId', `${process.platform === 'darwin' ? 'mac' : 'pc'}-${crypto.randomUUID()}`);
    this.deviceId = this.store.settings.syncDeviceId;
    this.deviceName = deviceName();
    this.raw = null; // the sync key
    this.keys = null;
    this.status = 'off'; // off | signed-out | starting | ready | needs-key | error
    this.error = null;
    this.lastSync = null;
    this.remoteTabs = {}; // other devices' open tabs
    this.pairing = null; // this device asking for the key: { id, privateKey, code }
    this.requests = []; // other devices asking: { id, name, kind, pubkey, code }
    this.ids = new Map(); // "collection\nkey" -> record id
    this.serverCollections = null; // what the server keeps (older servers don't say)
    this.timer = null;
    this.busy = null;
    this.again = false;
    this.lastRegister = 0;
    this.lastUpload = 0; // when this device last offered Lumio the account's key
    this.keyRetryAt = 0; // no key reads before this (Lumio said "too many requests")
    this.modeChanged = false; // the server says managed, but this computer keeps its own passphrase (remember)
  }

  addAdapters(list) { for (const a of list) this.adapters.set(a.name, a); }
  // Whether a collection syncs: its switch is on (some follow another type's,
  // like bookmark folders with Bookmarks), and the server keeps it. A server
  // that lists what it keeps is taken at its word; one that doesn't (older
  // ones) gets the original collections, and newer non-optional ones are
  // tried and retried later if refused (NEWER), but never an optional one
  // (it would refuse the whole upload).
  syncs(adapter) {
    if (!this.prefs.types[adapter.type || adapter.name]) return false;
    if (this.serverCollections) return this.serverCollections.has(adapter.name);
    return !adapter.optional;
  }

  // ---------------------------------------------------------------- settings
  get prefs() {
    const s = this.store.settings.sync || {};
    return { on: s.on !== false, types: Object.fromEntries(TYPES.map((t) => [t, (s.types?.[t] ?? !OFF_BY_DEFAULT.has(t)) !== false])) };
  }
  setPrefs({ on, types } = {}) {
    const cur = this.prefs;
    const next = { on: typeof on === 'boolean' ? on : cur.on, types: { ...cur.types, ...(types || {}) } };
    const added = TYPES.some((t) => next.types[t] && !cur.types[t]);
    this.store.setSetting('sync', next);
    if (added) this.file.data.cursor = 0; // pull everything again for the newly synced types
    this.file.save();
    this.state();
    this.soon(500);
  }

  state() {
    const s = {
      ...this.prefs,
      status: this.status,
      error: this.error,
      lastSync: this.lastSync,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      siteUrl: this.account.base,
      flow: this.flow,
      mode: this.mode,
      managedAvailable: this.file.data.managedAvailable === true,
      modeChanged: this.modeChanged,
      pairCode: this.pairing?.code || null,
      // Lumio approves other devices itself when it keeps the key.
      requests: this.flow === 'managed' ? [] : this.requests.map(({ id, name, kind, code, createdAt }) => ({ id, name, kind, code, createdAt })),
      otherTabs: Object.values(this.remoteTabs).filter((t) => t && t.windows),
    };
    this.onState(s);
    return s;
  }

  // ---------------------------------------------------------------- scheduling
  start() {
    clearInterval(this.interval);
    this.interval = setInterval(() => this.tick(), EVERY);
    this.interval.unref?.();
    this.soon(3000);
  }
  stop() { clearInterval(this.interval); clearTimeout(this.timer); }
  // A local change: sync in a few seconds.
  soon(ms = SOON) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
    this.timer.unref?.();
  }

  async tick() {
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = this.run().catch((err) => {
      this.status = this.keys ? 'ready' : 'error';
      this.error = err.message || String(err);
    }).finally(() => {
      this.busy = null;
      this.state();
      if (this.again) { this.again = false; this.soon(1000); }
    });
    return this.busy;
  }

  async api(path, { method = 'GET', body } = {}) {
    const a = this.account;
    const res = await a.fetch(`${a.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${a.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Sync failed (HTTP ${res.status}).`), { status: res.status, code: data.code });
    return data;
  }

  async run() {
    if (!this.prefs.on) { this.status = 'off'; this.error = null; return; }
    const who = this.account.state();
    if (!who.signedIn || !this.account.token()) { this.status = 'signed-out'; return; }
    // Another account signed in: start over (its own key and records).
    const owner = who.email || who.id || 'account';
    if (this.file.data.owner !== owner) {
      this.file.data = { owner, cursor: 0, records: {}, mode: 'managed', managedAvailable: false };
      this.file.save(true);
      this.raw = null;
      this.keys = null;
      this.pairing = null;
      this.requests = [];
      this.lastUpload = 0;
      this.keyRetryAt = 0;
      this.modeChanged = false;
    }
    if (this.status === 'off' || this.status === 'signed-out') this.status = 'starting';
    if (Date.now() - this.lastRegister > 10 * 60 * 1000) {
      await this.api('/api/sync/devices', { method: 'POST', body: { id: this.deviceId, name: this.deviceName, kind: 'computer', platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux' } });
      this.lastRegister = Date.now();
    }
    if (!(await this.ensureKey())) return;
    this.status = 'ready';
    this.error = null;
    this.catchUp();
    await this.pull();
    await this.push();
    if (this.flow === 'e2ee') await this.checkRequests();
    this.lastSync = Date.now();
  }

  // A collection this device starts syncing (new in this version, or one the
  // server only now keeps) pulls everything once first, so what other devices
  // already sent arrives before this device sends its own version.
  catchUp() {
    const d = this.file.data;
    const on = [...this.adapters.values()].filter((a) => this.syncs(a));
    d.started ||= on.filter((a) => !a.optional).map((a) => a.name);
    const fresh = on.map((a) => a.name).filter((n) => !d.started.includes(n));
    if (!fresh.length) return;
    d.started.push(...fresh);
    d.cursor = 0;
    this.file.save();
  }

  // ---------------------------------------------------------------- the key
  secretName() { return `syncKey:${this.file.data.owner}`; }
  // A new key for the account's own passphrase, kept until the server's
  // answer to the switch arrives (setMode): if the answer is lost, the next
  // run or a retry still has it.
  pendingName() { return `${this.secretName()}:pending`; }
  async useKey(raw) {
    this.raw = raw;
    this.keys = await C.deriveKeys(raw);
    this.ids.clear();
  }
  // The account's mode, as last heard from the server: 'managed' (Lumio keeps
  // the key, the default) or 'passphrase' (only devices have it).
  get mode() { return this.file.data.mode === 'passphrase' ? 'passphrase' : 'managed'; }
  // How this device gets the key: from Lumio ('managed'), or from another
  // device or the recovery key ('e2ee': passphrase mode, or a server that
  // doesn't hand out keys).
  get flow() { return this.file.data.managedAvailable === true && this.file.data.mode !== 'passphrase' ? 'managed' : 'e2ee'; }
  // The account's own passphrase is only turned off by a device that has its
  // key. passphraseCheck: the account's key check as last seen with its own
  // passphrase. While this computer has that key, the account counts as
  // managed again only once Lumio hands back that same key. Until then
  // (modeChanged: the server's word alone, from a stolen session or a changed
  // database) this computer stays on the e2ee flow: it doesn't give Lumio its
  // key, take one from Lumio, or ask to be approved.
  async remember(status) {
    const d = this.file.data;
    let mode = status.mode === 'passphrase' ? 'passphrase' : 'managed';
    const available = status.managedAvailable === true;
    const check = mode === 'passphrase' ? status.keyCheck || null : d.passphraseCheck;
    this.modeChanged = false;
    if (mode === 'managed' && d.mode === 'passphrase' && this.keys && this.keys.check === d.passphraseCheck && !(await this.lumioHasOurKey(status))) {
      mode = 'passphrase';
      this.modeChanged = status.mode === 'managed';
    }
    if (d.mode === mode && d.managedAvailable === available && d.passphraseCheck === check) return;
    d.mode = mode;
    d.managedAvailable = available;
    d.passphraseCheck = check;
    this.file.save();
  }
  // Lumio hands back exactly this computer's key: a device that had it gave
  // it to Lumio, so there's nothing left to keep from it.
  async lumioHasOurKey(status) {
    if (status.mode !== 'managed' || status.managedAvailable !== true || status.managedKey !== true || status.keyCheck !== this.keys.check || Date.now() < this.keyRetryAt) return false;
    try {
      const r = await this.api('/api/sync/key', { method: 'POST', body: {} });
      return r.status === 'ready' && r.key === C.toB64(this.raw);
    } catch (err) {
      this.backOff(err);
      return false;
    }
  }
  // Lumio's key routes allow a few reads an hour: after "too many requests",
  // none for a while (a refused read isn't counted, but isn't served either).
  backOff(err) { if (err.code === 'rate_limited') this.keyRetryAt = Date.now() + KEY_WAIT; }

  async ensureKey() {
    if (!this.keys) {
      const saved = this.store.getSecret(this.secretName());
      if (saved) await this.useKey(C.fromB64(saved));
    }
    const status = await this.api('/api/sync');
    this.serverCollections = Array.isArray(status.collections) ? new Set(status.collections) : null;
    await this.remember(status);
    if (this.flow === 'managed') return this.ensureManagedKey(status);
    if (!status.keyCheck) {
      // The first device: make the account's key.
      if (!this.keys) {
        await this.useKey(C.newKey());
        this.store.setSecret(this.secretName(), C.toB64(this.raw));
      }
      try {
        await this.api('/api/sync/init', { method: 'POST', body: { keyCheck: this.keys.check } });
        return true;
      } catch (err) {
        if (err.code !== 'key_mismatch') throw err; // another device just set it up
      }
      return this.ensureKey();
    }
    if (this.keys && this.keys.check === status.keyCheck) { this.pairing = null; return true; }
    // This computer's switch to the account's own passphrase went through,
    // but its answer never came: the key it made is the account's.
    if (await this.adoptPending(status.keyCheck)) return true;
    // Lumio's server says the account is managed again, without this
    // computer's key: nobody is asked for a key (Lumio would answer with its own).
    if (this.modeChanged) {
      this.status = 'error';
      this.error = MODE_CHANGED;
      this.pairing = null;
      return false;
    }
    // The account has a key this device doesn't: ask a device that has it.
    this.status = 'needs-key';
    this.keyCheck = status.keyCheck;
    await this.askForKey();
    return false;
  }

  // Lumio keeps the account's key: signing in is all this device needs. A
  // device that already has the key offers it to Lumio when Lumio doesn't
  // have it (an account from before managed sync, or a server that lost its
  // copy); nothing is encrypted again.
  async ensureManagedKey(status) {
    this.requests = [];
    if (this.keys && status.keyCheck && this.keys.check === status.keyCheck) {
      if (!status.managedKey && Date.now() - this.lastUpload > UPLOAD_EVERY) {
        this.lastUpload = Date.now();
        await this.api('/api/sync/key', { method: 'PUT', body: { key: C.toB64(this.raw) } }).catch(() => {}); // offered again next time
      }
      this.pairing = null;
      return true;
    }
    let keyCheck = status.keyCheck;
    if (!keyCheck || status.managedKey) {
      if (Date.now() < this.keyRetryAt) throw new Error(TOO_MANY); // not again yet: a sync error until then
      let r;
      try {
        r = await this.api('/api/sync/key', { method: 'POST', body: {} });
      } catch (err) {
        this.backOff(err);
        if (err.code === 'sync_keys_unavailable') { this.file.data.managedAvailable = false; this.file.save(); }
        if (err.code !== 'passphrase_mode') throw err;
        // The account switched to its own passphrase meanwhile: ask a device.
        this.file.data.mode = 'passphrase';
        this.file.save();
        this.soon(1000);
        return false;
      }
      if (r.status === 'ready') {
        await this.adoptKey(await this.keyFrom(r));
        return true;
      }
      keyCheck = r.keyCheck || keyCheck; // waiting
    }
    // The account's key is only on devices that haven't updated yet: one of
    // them can approve this one as before, or the recovery key works. Once a
    // device offers Lumio the key, Lumio approves this request itself (or the
    // next run gets the key).
    this.status = 'needs-key';
    this.keyCheck = keyCheck;
    await this.askForKey();
    return false;
  }

  // The key in Lumio's answer, if it's the one Lumio says the account has.
  async keyFrom(r) {
    const raw = typeof r.key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(r.key) ? C.fromB64(r.key) : null;
    if (!raw || raw.length !== 32 || (await C.deriveKeys(raw)).check !== r.keyCheck) throw new Error(BAD_KEY);
    return raw;
  }

  async askForKey() {
    if (this.pairing) {
      const r = await this.api(`/api/sync/pair/${this.pairing.id}`);
      if (r.status === 'approved') {
        const raw = await C.unwrapFromApprover(this.pairing.privateKey, r.approverPub, r.wrapped);
        if ((await C.deriveKeys(raw)).check !== this.keyCheck) throw new Error('The key from the other device didn’t match. Try again.');
        await this.adoptKey(raw);
        this.soon(200);
        return;
      }
      if (r.status === 'pending') return;
      this.pairing = null; // denied or expired: ask again
    }
    const kp = await C.pairKeyPair();
    const { id } = await this.api('/api/sync/pair', { method: 'POST', body: { device: this.deviceId, name: this.deviceName, kind: 'computer', pubkey: kp.publicKey } });
    this.pairing = { id, privateKey: kp.privateKey, code: await C.pairCode(kp.publicKey) };
    // Check back often while someone may be approving.
    for (const ms of [5000, 15000, 30000]) setTimeout(() => this.status === 'needs-key' && this.tick(), ms).unref?.();
  }

  async adoptKey(raw) {
    await this.useKey(raw);
    this.store.setSecret(this.secretName(), C.toB64(raw));
    this.pairing = null;
    this.status = 'ready';
    // Merge: everything here goes up, everything there comes down.
    this.file.data.cursor = 0;
    this.file.data.records = {};
    this.file.save(true);
  }

  // The recovery key typed in Settings.
  async useRecoveryKey(text) {
    const raw = C.fromRecovery(text);
    if (!raw) return { ok: false, error: 'That isn’t a recovery key. It’s 13 groups of 4 letters and numbers.' };
    const status = await this.api('/api/sync');
    if (status.keyCheck && (await C.deriveKeys(raw)).check !== status.keyCheck) return { ok: false, error: 'That recovery key is for a different account, or it has a typo.' };
    await this.adoptKey(raw);
    this.soon(200);
    return { ok: true };
  }

  // Never while this computer's key isn't the account's (waiting for a new
  // one, or paused): it wouldn't unlock anything.
  recoveryKey() { return this.raw && this.status !== 'needs-key' && this.status !== 'error' ? C.toRecovery(this.raw) : null; }

  // The key of this computer's own switch to the account's passphrase
  // (setMode), once the server shows it took it.
  async adoptPending(keyCheck) {
    const saved = this.store.getSecret(this.pendingName());
    if (!saved || !keyCheck) return false;
    const raw = C.fromB64(saved);
    if ((await C.deriveKeys(raw)).check !== keyCheck) return false;
    await this.adoptKey(raw);
    this.store.setSecret(this.pendingName(), null);
    this.file.data.mode = 'passphrase';
    this.file.data.passphraseCheck = keyCheck;
    this.file.save(true);
    return true;
  }

  // Other devices asking for the key (shown with their code to compare).
  async checkRequests() {
    const { requests } = await this.api(`/api/sync/pair?device=${this.deviceId}`);
    const known = new Set(this.requests.map((r) => r.id));
    this.requests = await Promise.all(requests.map(async (r) => ({ ...r, code: await C.pairCode(r.pubkey) })));
    for (const r of this.requests) if (!known.has(r.id)) this.onPairRequest(r);
  }
  async answer(id, approve) {
    const r = this.requests.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'That request expired. Ask again from the new device.' };
    if (approve) {
      if (!this.raw) return { ok: false, error: 'This device isn’t synced yet.' };
      const { approverPub, wrapped } = await C.wrapForDevice(this.raw, r.pubkey);
      await this.api(`/api/sync/pair/${id}`, { method: 'POST', body: { approve: true, approverPub, wrapped } });
    } else {
      await this.api(`/api/sync/pair/${id}`, { method: 'POST', body: { approve: false } });
    }
    this.requests = this.requests.filter((x) => x.id !== id);
    this.state();
    return { ok: true };
  }

  // Turning sync off for the whole account deletes the synced copy.
  async deleteEverything() {
    await this.api('/api/sync', { method: 'DELETE' });
    this.store.setSecret(this.secretName(), null);
    this.store.setSecret(this.pendingName(), null);
    this.raw = null;
    this.keys = null;
    this.file.data = { owner: this.file.data.owner, cursor: 0, records: {} };
    this.file.save(true);
    this.setPrefs({ on: false });
    return { ok: true };
  }

  // Settings › Sync › Reset sync, when Lumio keeps the key: the server
  // deletes everything synced and makes a new key. Sync stays on: this
  // computer and the account's other devices upload what they have again.
  async resetSync() {
    if (this.flow !== 'managed') throw new Error('Reset is for accounts where Lumio keeps the sync key.');
    return this.between(async () => {
      const r = await this.api('/api/sync/reset', { method: 'POST', body: { confirm: true } });
      if (r.status === 'ready') await this.adoptKey(await this.keyFrom(r));
      this.soon(200);
      return {};
    });
  }

  // Settings › Sync › Advanced › Encrypt with my own passphrase.
  // On: the account starts over with a new key that only devices have (the
  // server deletes its copy and everything synced with it); this computer
  // uploads what it has, and other devices need approval or the recovery key.
  // Off: Lumio keeps this computer's key, so signing in is enough again.
  async setMode(mode) {
    return this.between(async () => {
      // modeChanged: the server says managed meanwhile; this computer can still choose.
      if (!this.raw || (this.status !== 'ready' && !this.modeChanged)) throw new Error('Wait for sync to finish turning on first.');
      if (mode === 'passphrase') {
        // Saved before asking, so a lost answer doesn't lose the account's new
        // key; a retry asks with the same one.
        const pending = this.pendingName();
        const saved = this.store.getSecret(pending);
        const raw = saved ? C.fromB64(saved) : C.newKey();
        if (!saved) this.store.setSecret(pending, C.toB64(raw));
        const { check } = await C.deriveKeys(raw);
        let r;
        try {
          r = await this.api('/api/sync/mode', { method: 'PUT', body: { mode, keyCheck: check } });
        } catch (err) {
          if (err.code !== 'already_passphrase') {
            if (err.status >= 400 && err.status < 500) this.store.setSecret(pending, null); // refused: never taken
            throw err;
          }
          const status = await this.api('/api/sync');
          if (status.keyCheck !== check) {
            this.store.setSecret(pending, null);
            if (!this.keys || status.keyCheck !== this.keys.check) throw new Error(ALREADY_PASSPHRASE);
            // Already done (the next run took the key of the attempt before).
            this.file.data.mode = 'passphrase';
            this.file.save();
            this.soon(200);
            return { mode };
          }
          r = { keyCheck: check }; // the attempt before went through; its answer was lost
        }
        if (r.keyCheck !== check) throw new Error('Lumio’s server didn’t take the new key. Try again.');
        await this.adoptKey(raw);
        this.store.setSecret(pending, null);
        this.file.data.mode = 'passphrase';
        this.file.data.passphraseCheck = check;
        this.file.save(true);
      } else {
        const r = await this.api('/api/sync/mode', { method: 'PUT', body: { mode: 'managed', key: C.toB64(this.raw) } }).catch((err) => {
          if (err.code === 'already_managed') return null;
          throw err;
        });
        if (r || this.modeChanged) {
          // Already managed when this computer said so itself: the person chose it.
          this.file.data.mode = 'managed';
          this.modeChanged = false;
          this.file.save();
        }
      }
      this.soon(200);
      return { mode };
    });
  }

  // Signed out of Lumio, or the session ended (main/account.js): a key Lumio
  // keeps (flow managed) leaves this computer too, and the next sign-in gets
  // it back. Otherwise it stays, as before managed sync: with the account's
  // own passphrase, or a server that doesn't keep keys, no other copy may
  // exist, and every sign-in would need an approval. Never because a run
  // doesn't know the account yet (starting, offline).
  signedOut() {
    const out = () => {
      if (this.flow === 'managed') this.forgetKey();
      this.status = 'signed-out';
      this.state();
    };
    out();
    // A run that was getting the key as the session ended doesn't leave it here.
    this.busy?.then(() => { if (!this.account.token()) out(); });
  }
  forgetKey() {
    this.store.setSecret(this.secretName(), null);
    this.store.setSecret(this.pendingName(), null);
    this.raw = null;
    this.keys = null;
    this.pairing = null;
    this.keyCheck = null;
    this.requests = [];
    this.ids.clear();
    this.file.data.cursor = 0;
    this.file.data.records = {};
    this.file.save(true);
  }

  // Changes the key between runs, so a run never uses the old key and the new one.
  async between(fn) {
    while (this.busy) await this.busy;
    const out = fn();
    this.busy = out.catch(() => {}).finally(() => {
      this.busy = null;
      this.state();
      if (this.again) { this.again = false; this.soon(1000); }
    });
    return out;
  }

  // ---------------------------------------------------------------- records
  async idFor(collection, key) {
    const k = `${collection}\n${key}`;
    let id = this.ids.get(k);
    if (!id) { id = await C.recordId(this.keys, collection, key); this.ids.set(k, id); }
    return id;
  }

  async pull() {
    const records = this.file.data.records;
    for (let pages = 0; pages < 50; pages++) {
      const res = await this.api(`/api/sync/changes?since=${this.file.data.cursor}&device=${encodeURIComponent(this.deviceId)}&limit=500`);
      const byType = new Map();
      for (const it of res.items) {
        const adapter = this.adapters.get(it.collection);
        if (!adapter || !this.syncs(adapter)) continue;
        let key;
        let record = null;
        if (it.deleted) {
          key = records[it.id]?.k;
          if (key == null) continue; // never had it
        } else {
          try {
            const v = await C.open(this.keys, it.collection, it.id, it.data);
            key = v.k;
            record = v.r;
          } catch { continue; } // not readable with this key
        }
        if (!byType.has(it.collection)) byType.set(it.collection, []);
        byType.get(it.collection).push({ id: it.id, key, record, updatedAt: it.updatedAt });
      }
      for (const [type, list] of byType) {
        const adapter = this.adapters.get(type);
        // Changed here since the last sync too: this device's version wins.
        const local = new Map(adapter.entries().map((e) => [e.key, e.hash]));
        const take = list.filter((c) => {
          const lastHash = records[c.id]?.h;
          const now = local.get(c.key);
          return now === undefined || lastHash === undefined ? true : now === lastHash;
        });
        const rejected = new Set(await adapter.apply(take.map(({ key, record }) => ({ key, record }))) || []);
        for (const c of take) {
          if (!c.record) delete records[c.id];
          else if (!rejected.has(c.key)) records[c.id] = { c: type, k: c.key, h: adapter.hashOf(c.record) };
          else records[c.id] = { c: type, k: c.key, h: 'rejected' }; // goes back up as deleted
        }
      }
      this.file.data.cursor = res.cursor;
      this.file.save();
      if (!res.more) break;
    }
  }

  async push() {
    const records = this.file.data.records;
    const out = [];
    this.refused ||= new Map(); // newer collection -> when to try it again
    for (const [type, adapter] of this.adapters) {
      if (!this.syncs(adapter) || this.refused.get(type) > Date.now()) continue;
      const seen = new Set();
      for (const e of adapter.entries()) {
        const id = await this.idFor(type, e.key);
        seen.add(id);
        if (records[id]?.h === e.hash) continue;
        const record = e.get();
        if (record == null) continue;
        out.push({ id, type, key: e.key, hash: e.hash, record });
      }
      for (const [id, r] of Object.entries(records)) {
        if (r.c !== type || seen.has(id)) continue;
        if (r.h !== 'rejected' && adapter.keepAbsent?.(r.k)) continue; // not deleted, just out of this device's range
        out.push({ id, type, key: r.k, deleted: true });
      }
    }
    // Newer collections go in batches of their own, after the rest.
    const batches = [];
    for (const group of [out.filter((it) => !NEWER.has(it.type)), ...[...NEWER].map((t) => out.filter((it) => it.type === t))]) {
      for (let i = 0; i < group.length; i += BATCH) batches.push(group.slice(i, i + BATCH));
    }
    for (const batch of batches) {
      const items = [];
      for (const it of batch) {
        if (it.deleted) { items.push({ id: it.id, collection: it.type, deleted: true }); continue; }
        const json = JSON.stringify(it.record);
        if (json.length > MAX_RECORD) { records[it.id] = { c: it.type, k: it.key, h: it.hash }; continue; } // too big to sync
        items.push({ id: it.id, collection: it.type, data: await C.seal(this.keys, it.type, it.id, { k: it.key, r: it.record }), updatedAt: Date.now() });
      }
      if (items.length) {
        try {
          // keyCheck: the server refuses records sealed with a key the account
          // no longer has (reset, or its own passphrase, since this run began).
          await this.api('/api/sync/push', { method: 'POST', body: { device: this.deviceId, keyCheck: this.keys.check, items } });
        } catch (err) {
          if (err.code === 'key_mismatch') { this.again = true; return; } // the next run gets the new key, then uploads everything
          if (!(err.status === 400 && NEWER.has(batch[0].type))) throw err;
          this.refused.set(batch[0].type, Date.now() + RETRY_NEWER); // an older server
          continue;
        }
      }
      for (const it of batch) {
        if (it.deleted) delete records[it.id];
        else records[it.id] = { c: it.type, k: it.key, h: it.hash };
      }
      this.file.save();
    }
  }
}

module.exports = { SyncEngine, TYPES, hash };
