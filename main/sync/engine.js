// Lumio Sync on this computer: keeps bookmarks, passwords, history, chats,
// workflows, settings and open tabs the same on every device signed in to the
// same Lumio account. Records are encrypted here (main/sync/crypto.js) before
// they leave; the server stores ciphertext.
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

const TYPES = ['bookmarks', 'passwords', 'history', 'chats', 'workflows', 'projects', 'settings', 'tabs'];
const BATCH = 100;
const EVERY = 60 * 1000;
const SOON = 4000;
const MAX_RECORD = 420 * 1024; // JSON, before encryption

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
    this.timer = null;
    this.busy = null;
    this.again = false;
    this.lastRegister = 0;
  }

  addAdapters(list) { for (const a of list) this.adapters.set(a.name, a); }

  // ---------------------------------------------------------------- settings
  get prefs() {
    const s = this.store.settings.sync || {};
    return { on: s.on !== false, types: Object.fromEntries(TYPES.map((t) => [t, s.types?.[t] !== false])) };
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
      pairCode: this.pairing?.code || null,
      requests: this.requests.map(({ id, name, kind, code, createdAt }) => ({ id, name, kind, code, createdAt })),
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
      this.file.data = { owner, cursor: 0, records: {} };
      this.file.save(true);
      this.raw = null;
      this.keys = null;
      this.pairing = null;
    }
    if (this.status === 'off' || this.status === 'signed-out') this.status = 'starting';
    if (Date.now() - this.lastRegister > 10 * 60 * 1000) {
      await this.api('/api/sync/devices', { method: 'POST', body: { id: this.deviceId, name: this.deviceName, kind: 'computer', platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux' } });
      this.lastRegister = Date.now();
    }
    if (!(await this.ensureKey())) return;
    this.status = 'ready';
    this.error = null;
    await this.pull();
    await this.push();
    await this.checkRequests();
    this.lastSync = Date.now();
  }

  // ---------------------------------------------------------------- the key
  secretName() { return `syncKey:${this.file.data.owner}`; }
  async useKey(raw) {
    this.raw = raw;
    this.keys = await C.deriveKeys(raw);
    this.ids.clear();
  }
  async ensureKey() {
    if (!this.keys) {
      const saved = this.store.getSecret(this.secretName());
      if (saved) await this.useKey(C.fromB64(saved));
    }
    const status = await this.api('/api/sync');
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
    // The account has a key this device doesn't: ask a device that has it.
    this.status = 'needs-key';
    this.keyCheck = status.keyCheck;
    await this.askForKey();
    return false;
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

  recoveryKey() { return this.raw ? C.toRecovery(this.raw) : null; }

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
    this.raw = null;
    this.keys = null;
    this.file.data = { owner: this.file.data.owner, cursor: 0, records: {} };
    this.file.save(true);
    this.setPrefs({ on: false });
    return { ok: true };
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
    const types = this.prefs.types;
    for (let pages = 0; pages < 50; pages++) {
      const res = await this.api(`/api/sync/changes?since=${this.file.data.cursor}&device=${encodeURIComponent(this.deviceId)}&limit=500`);
      const byType = new Map();
      for (const it of res.items) {
        const adapter = this.adapters.get(it.collection);
        if (!adapter || !types[it.collection]) continue;
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
    const types = this.prefs.types;
    const out = [];
    for (const [type, adapter] of this.adapters) {
      if (!types[type]) continue;
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
    for (let i = 0; i < out.length; i += BATCH) {
      const batch = out.slice(i, i + BATCH);
      const items = [];
      for (const it of batch) {
        if (it.deleted) { items.push({ id: it.id, collection: it.type, deleted: true }); continue; }
        const json = JSON.stringify(it.record);
        if (json.length > MAX_RECORD) { records[it.id] = { c: it.type, k: it.key, h: it.hash }; continue; } // too big to sync
        items.push({ id: it.id, collection: it.type, data: await C.seal(this.keys, it.type, it.id, { k: it.key, r: it.record }), updatedAt: Date.now() });
      }
      if (items.length) await this.api('/api/sync/push', { method: 'POST', body: { device: this.deviceId, items } });
      for (const it of batch) {
        if (it.deleted) delete records[it.id];
        else records[it.id] = { c: it.type, k: it.key, h: it.hash };
      }
      this.file.save();
    }
  }
}

module.exports = { SyncEngine, TYPES, hash };
