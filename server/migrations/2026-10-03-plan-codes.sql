-- One-time plan codes (see src/codes.ts).
CREATE TABLE IF NOT EXISTS plan_codes (
  code_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  redeemed_by TEXT,
  redeemed_at INTEGER,
  plan_until INTEGER
);
