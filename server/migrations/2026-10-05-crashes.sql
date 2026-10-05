-- 2026-10-05: crash reports from Lumio Browser (opt-in; src/crashes.ts).
-- Same as schema.sql. Run once:
--   npx wrangler d1 execute lumio --remote --file migrations/2026-10-05-crashes.sql
CREATE TABLE IF NOT EXISTS crashes (
  id TEXT PRIMARY KEY,                   -- cr_<24 hex>
  created_at INTEGER NOT NULL,
  version TEXT,                          -- Lumio Browser's version
  platform TEXT,                         -- darwin | win32 | linux
  arch TEXT,                             -- arm64 | x64 | ...
  channel TEXT,                          -- stable | beta | dev
  process_type TEXT,                     -- browser | renderer | gpu-process | utility | ...
  reason TEXT,                           -- EXC_BAD_ACCESS, uncaughtException, oom, ...
  has_dump INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL,               -- groups the same crash: "EXC_BAD_ACCESS in Electron Framework+0x2a3f10"
  message TEXT,                          -- JavaScript errors: the scrubbed message
  stack TEXT,                            -- JavaScript errors: the stack, with Lumio's own file paths only
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS crashes_created ON crashes (created_at);
CREATE INDEX IF NOT EXISTS crashes_ip ON crashes (ip_hash, created_at);
