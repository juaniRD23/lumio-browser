-- 2026-10-08: managed Lumio Sync (docs/sync-managed.md). Same as schema.sql.
-- Run once:  npx wrangler d1 execute lumio --remote --file migrations/2026-10-08-sync-keys.sql
CREATE TABLE IF NOT EXISTS sync_keys (
  owner TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'managed',
  wrapped TEXT,
  key_check TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_key_events (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_key_events_owner ON sync_key_events (owner, kind, created_at);
CREATE INDEX IF NOT EXISTS sync_key_events_ip ON sync_key_events (ip_hash, kind, created_at);
