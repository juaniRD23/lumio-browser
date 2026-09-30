-- lumio-browser-api ledger (Cloudflare D1)
-- Recent Lumio session checks, keyed by a SHA-256 of the token (never the token itself).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  plan TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
-- One row per agent step: what it held while running and what it really cost.
-- A retried step replays `result` instead of running (and charging) again.
CREATE TABLE IF NOT EXISTS steps (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  plan TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL, -- running | done | failed
  held_microusd INTEGER NOT NULL,
  cost_microusd INTEGER,
  result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_owner_time ON steps (owner, created_at);
CREATE INDEX IF NOT EXISTS steps_plan_time ON steps (plan, created_at);
