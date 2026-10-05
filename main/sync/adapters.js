// What Lumio Sync syncs, one adapter per collection. Each one lists its
// records ({ key, hash, get() }), says what a record's hash is (hashOf), and
// applies other devices' changes ({ key, record | null to delete }); apply may
// return keys it rejected (they're deleted everywhere instead).
const { hash } = require('./engine');

const DAY = 24 * 3600 * 1000;
const HISTORY_DAYS = 30;
const HISTORY_MAX = 2000;
const CHAT_MAX = 400 * 1024;
const SETTINGS = ['searchEngine', 'approvalMode', 'reasoning', 'showBookmarksBar', 'memorySaver', 'memorySaverMinutes', 'startup', 'offerPasswords', 'autofillPasswords', 'profile', 'appearance', 'autofillAddresses', 'autofillCards', 'formHistory'];

function simple(name, { entries, apply, keepAbsent }) {
  return {
    name,
    hashOf: (r) => hash(r),
    entries: () => entries().map(([key, r]) => ({ key, hash: hash(r), get: () => r })),
    apply,
    keepAbsent,
  };
}

// ---------------------------------------------------------------- bookmarks
function bookmarks(store) {
  return simple('bookmarks', {
    entries: () => store.bookmarks().map((b, i) => [b.url, { url: b.url, title: b.title, time: b.time, pos: i }]),
    apply: (changes) => store.applySyncedBookmarks(changes),
  });
}

// ---------------------------------------------------------------- history
// The last 30 days (up to 2,000 visits). Older visits leaving that window
// aren't deleted elsewhere.
function history(store) {
  const cutoff = () => Date.now() - HISTORY_DAYS * DAY;
  return simple('history', {
    entries: () => store.history().filter((h) => h.time >= cutoff()).slice(-HISTORY_MAX).map((h) => [`${h.time}|${h.url}`, { url: h.url, title: h.title, time: h.time }]),
    apply: (changes) => store.applySyncedHistory(changes),
    keepAbsent: (key) => Number(String(key).split('|')[0]) < cutoff() + DAY,
  });
}

// ---------------------------------------------------------------- passwords
// Decrypted from this computer's keychain only to be encrypted again for
// sync. Changes are noticed by their "updated" time, so passwords aren't
// decrypted every minute.
function passwords(vault) {
  const meta = (r) => ({ origin: r.origin, username: r.username, created: r.created, updated: r.updated });
  return {
    name: 'passwords',
    hashOf: (r) => hash(meta(r)),
    entries() {
      if (!vault.available()) return [];
      return vault.entries.map((e) => ({
        key: e.id,
        hash: hash(meta(e)),
        get: () => {
          const password = vault.dec(e.password);
          return password == null ? null : { ...meta(e), password, note: e.note ? vault.dec(e.note) || '' : '' };
        },
      }));
    },
    apply(changes) {
      if (!vault.available()) return changes.map((c) => c.key);
      const rejected = [];
      const list = vault.file.data.entries;
      for (const { key, record: r } of changes) {
        const i = list.findIndex((e) => e.id === key);
        if (!r) { if (i >= 0) list.splice(i, 1); continue; }
        if (!r.origin || !r.password) { rejected.push(key); continue; }
        const fields = { origin: r.origin, username: String(r.username || '').slice(0, 300), password: vault.enc(r.password), note: r.note ? vault.enc(r.note) : null, created: r.created, updated: r.updated };
        if (i >= 0) { Object.assign(list[i], fields); continue; }
        // The same login saved separately on two devices: the newer one stays.
        const dup = list.findIndex((e) => e.origin === r.origin && e.username === fields.username);
        if (dup >= 0) {
          if ((list[dup].updated || 0) > (r.updated || 0)) { rejected.push(key); continue; }
          list.splice(dup, 1);
        }
        list.push({ id: key, ...fields, lastUsed: null });
      }
      vault.file.save(true);
      return rejected;
    },
  };
}

// ---------------------------------------------------------------- passkeys
// Lumio's own passkeys, private key included: decrypted from this computer's
// keychain only to be encrypted again for sync. Passkeys made before syncing
// existed told their sites they're device-bound, so they stay on their computer.
function passkeys(store) {
  const meta = (k) => ({ rpId: k.rpId, userId: k.userId, userName: k.userName, displayName: k.displayName, created: k.created });
  return {
    name: 'passkeys',
    hashOf: (r) => hash(meta(r)),
    entries() {
      if (!store.available()) return [];
      return store.keys.filter((k) => k.be).map((k) => ({ key: k.id, hash: hash(meta(k)), get: () => store.syncRecord(k.id) }));
    },
    apply: (changes) => store.applySynced(changes),
  };
}

// ---------------------------------------------------------------- addresses and cards
// Like passwords: noticed by their "updated" time, decrypted only to be
// encrypted again for sync. Cards sync only after the person turns on
// "Payment methods" in Settings › Sync (see OFF_BY_DEFAULT in engine.js).
function addresses(store) {
  const meta = (r) => ({ created: r.created, updated: r.updated });
  return {
    name: 'addresses',
    hashOf: (r) => hash(meta(r)),
    entries: () => (store.available() ? store.addressEntries.map((e) => ({ key: e.id, hash: hash(meta(e)), get: () => store.addressRecord(e.id) })) : []),
    apply: (changes) => store.applySyncedAddresses(changes),
  };
}
function cards(store) {
  const meta = (r) => ({ created: r.created, updated: r.updated });
  return {
    name: 'cards',
    hashOf: (r) => hash(meta(r)),
    entries: () => (store.available() ? store.cardEntries.map((c) => ({ key: c.id, hash: hash(meta(c)), get: () => store.cardRecord(c.id) })) : []),
    apply: (changes) => store.applySyncedCards(changes),
  };
}

// ---------------------------------------------------------------- chats
// Lumio chats (as saved on disk, without pictures). Very long ones are
// shortened to fit: long tool results and pasted pages are cut first.
function shrinkChat(chat) {
  let json = JSON.stringify(chat);
  if (json.length <= CHAT_MAX) return chat;
  const cut = (t, n) => (typeof t === 'string' && t.length > n ? `${t.slice(0, n)}\n[… shortened for sync]` : t);
  const c = {
    ...chat,
    messages: chat.messages.map((m) => (m.role === 'tool' ? { ...m, content: cut(m.content, 1500) }
      : Array.isArray(m.content) ? { ...m, content: m.content.map((p) => (p.type === 'text' ? { ...p, text: cut(p.text, 4000) } : p)) } : m)),
  };
  json = JSON.stringify(c);
  while (json.length > CHAT_MAX && c.messages.length > 2) {
    c.messages = c.messages.slice(Math.ceil(c.messages.length / 4));
    while (c.messages.length && c.messages[0].role !== 'user') c.messages.shift(); // start at a request
    json = JSON.stringify(c);
  }
  return json.length <= CHAT_MAX ? c : null;
}
function chats(chatStore, { onApplied = () => {} } = {}) {
  const cache = new Map(); // id -> { stamp, rec, hash }
  return {
    name: 'chats',
    hashOf: (r) => hash(r),
    entries() {
      const out = [];
      for (const chat of chatStore.chats) {
        if (chatStore.running.has(chat.id)) continue; // syncs when the run ends
        const stamp = `${chat.updatedAt}:${chat.messages.length}:${chat.display.length}`;
        let c = cache.get(chat.id);
        if (c?.stamp !== stamp) {
          const rec = shrinkChat(JSON.parse(JSON.stringify(chatStore.forDisk(chat))));
          c = { stamp, rec, hash: rec ? hash(rec) : null };
          cache.set(chat.id, c);
        }
        if (c.rec) out.push({ key: chat.id, hash: c.hash, get: () => c.rec });
      }
      return out;
    },
    apply(changes) {
      for (const { key, record } of changes) {
        if (chatStore.running.has(key)) continue;
        const i = chatStore.chats.findIndex((x) => x.id === key);
        if (!record) { if (i >= 0) chatStore.chats.splice(i, 1); continue; }
        if (!Array.isArray(record.messages) || !Array.isArray(record.display)) continue;
        const chat = { ...record, id: key };
        if (i >= 0) chatStore.chats[i] = chat; else chatStore.chats.push(chat);
        cache.delete(key);
      }
      chatStore.save();
      onApplied();
    },
  };
}

// ---------------------------------------------------------------- workflows
function workflows(store) {
  return simple('workflows', {
    entries: () => Object.entries(store.records()),
    apply: (changes) => { for (const { key, record } of changes) store.applyRemote(key, record); store.save(); },
  });
}

// ---------------------------------------------------------------- projects
function projects(store) {
  return simple('projects', {
    entries: () => Object.entries(store.records()),
    apply: (changes) => { for (const { key, record } of changes) store.applyRemote(key, record); store.save(); },
  });
}

// ---------------------------------------------------------------- settings
function settings(store, { onApplied = () => {} } = {}) {
  const pick = () => Object.fromEntries(SETTINGS.filter((k) => store.settings[k] !== undefined).map((k) => [k, store.settings[k]]));
  return simple('settings', {
    entries: () => [['prefs', pick()]],
    apply: (changes) => {
      const r = changes.find((c) => c.key === 'prefs')?.record;
      if (!r) return;
      for (const k of SETTINGS) if (k in r && JSON.stringify(store.settings[k]) !== JSON.stringify(r[k])) store.setSetting(k, r[k]);
      onApplied();
    },
  });
}

// ---------------------------------------------------------------- open tabs
// This computer's tabs (for "tabs from your other devices" and the phone).
// Other devices' records are kept in memory, never applied to this one.
function tabs({ deviceId, deviceName, platform, windows, remote, onApplied = () => {} }) {
  return {
    name: 'tabs',
    hashOf: (r) => hash({ ...r, at: 0 }),
    entries() {
      const r = {
        name: deviceName,
        platform,
        windows: windows().map((w) => ({ tabs: w.tabs.filter((t) => /^https?:/.test(t.url || '')).slice(0, 100).map((t) => ({ url: t.url, title: String(t.title || '').slice(0, 200) })) })).filter((w) => w.tabs.length),
      };
      return [{ key: deviceId, hash: hash({ ...r, at: 0 }), get: () => ({ ...r, at: Date.now() }) }];
    },
    apply(changes) {
      for (const { key, record } of changes) {
        if (key === deviceId) continue;
        if (record) remote[key] = { ...record, deviceId: key }; else delete remote[key];
      }
      onApplied();
    },
    keepAbsent: (key) => key !== deviceId,
  };
}

module.exports = { bookmarks, history, passwords, passkeys, addresses, cards, chats, workflows, projects, settings, tabs, shrinkChat, SETTINGS };
