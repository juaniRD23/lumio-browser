-- 2026-10-02 (v0.6.3): Lumio Sync, the phone companion's relay, push
-- subscriptions and the phone app's sign-in codes. Same as schema.sql.
-- Lumio Sync: end-to-end encrypted records (the server sees ciphertext, opaque
-- ids and collection names only). Replacing a row gives it a new seq, which
-- is how devices find what changed.
CREATE TABLE IF NOT EXISTS sync_meta (
  owner TEXT PRIMARY KEY,
  key_check TEXT NOT NULL,               -- lets a device tell whether its key is the account's
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  id TEXT NOT NULL,                      -- HMAC of the collection and key, made on the device
  collection TEXT NOT NULL,              -- one of COLLECTIONS in src/sync.ts (bookmarks, bookmarkTree, readingList, savedGroups, passwords, passkeys, addresses, cards, history, chats, workflows, projects, settings, tabs)
  data TEXT,                             -- AES-GCM ciphertext (base64); NULL when deleted
  deleted INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  device TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_items_owner_id ON sync_items (owner, id);
CREATE INDEX IF NOT EXISTS sync_items_owner_seq ON sync_items (owner, seq);
CREATE TABLE IF NOT EXISTS sync_devices (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- computer | phone
  platform TEXT,
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT,                           -- a computer's encrypted live status, for the phone
  status_at INTEGER,
  PRIMARY KEY (owner, id)
);
CREATE TABLE IF NOT EXISTS sync_pairings (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  device TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  pubkey TEXT NOT NULL,                  -- the new device's ECDH public key
  status TEXT NOT NULL,                  -- pending | approved | denied | done
  approver_pub TEXT,
  wrapped TEXT,                          -- the sync key, encrypted for the new device
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_pairings_owner ON sync_pairings (owner, created_at);
-- The phone companion's relay: commands to a computer, notices to phones (encrypted).
CREATE TABLE IF NOT EXISTS companion_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- command | notice
  sender TEXT NOT NULL,
  target TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS companion_messages_owner ON companion_messages (owner, kind, seq);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  owner TEXT NOT NULL,
  device TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, device)
);

-- The phone app's sign-in hand-off: one-time codes, 2 minutes.
CREATE TABLE IF NOT EXISTS app_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
