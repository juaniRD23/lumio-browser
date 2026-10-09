-- Lumio (lumio-co.online) on Cloudflare D1. Safe to run again (IF NOT EXISTS).

-- Accounts: signed in with Google, Apple or an email and a password. The plan comes from the Stripe subscription.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,       -- Google's account id; 'apple:<sub>' for an account made with Apple; 'email:<users.id>' for one made with email + password
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  plan TEXT NOT NULL DEFAULT 'free',     -- free | go | plus | pro | max
  plan_status TEXT,                      -- Stripe subscription status, or 'code' (a month from a plan code)
  plan_renews_at INTEGER,
  subscription_id TEXT,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL,
  role TEXT,                             -- 'owner' can see the Spend page
  apple_sub TEXT,                        -- Sign in with Apple's account id (the Lumio iPhone and iPad app)
  apple_refresh TEXT,                    -- Apple's refresh token, encrypted (revoked when the account is deleted)
  password_hash TEXT,                    -- 'pbkdf2-sha256$<iterations>$<salt>$<hash>' (base64url); NULL: no password
  email_unverified INTEGER               -- 1: made with Sign in with Apple from an email Apple hadn't verified (never found by its email); NULL or 0: verified
);
CREATE INDEX IF NOT EXISTS users_customer ON users (stripe_customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_apple ON users (apple_sub);
-- Accounts by email; only one per email can have a password (and its email then never changes).
CREATE INDEX IF NOT EXISTS users_email ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_password_email ON users (email) WHERE password_hash IS NOT NULL;

-- Sessions, stored by a SHA-256 of the token (never the token itself).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Google sign-in in progress (state + PKCE verifier), for 15 minutes.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  next TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every model call (Lumio Browser step or Chat reply): what it held while
-- running and what it really cost. Browser steps keep `result` for replays.
CREATE TABLE IF NOT EXISTS steps (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  plan TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'browser',  -- browser | chat | image | voice | translate
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,                  -- running | done | failed
  held_microusd INTEGER NOT NULL,
  cost_microusd INTEGER,
  result TEXT,
  created_at INTEGER NOT NULL,
  gen_ids TEXT,                          -- OpenRouter generation IDs (JSON) for the double-check
  verified_at INTEGER,                   -- when OpenRouter's record was looked up
  billed_microusd INTEGER,               -- OpenRouter's official cost (null if it couldn't be found)
  ms INTEGER,                            -- how long the call took
  model TEXT                             -- which model answered (voice: speech-to-text or text-to-speech)
);
CREATE INDEX IF NOT EXISTS steps_owner_time ON steps (owner, created_at);
CREATE INDEX IF NOT EXISTS steps_unverified ON steps (verified_at, created_at);
CREATE INDEX IF NOT EXISTS steps_plan_time ON steps (plan, created_at);

-- Web Chat.
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_user ON chats (user_id, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,                    -- user | assistant
  content TEXT NOT NULL,
  files TEXT,                            -- JSON array of file ids (attached, or made by Lumio)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages (chat_id, id);

-- Files in Chat: pictures (bytes in R2 at files/<id>), attached documents (their
-- text) and documents Lumio wrote (their content). chat_id is set once sent.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT,
  kind TEXT NOT NULL,                    -- image | text | document
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  text TEXT,
  meta TEXT,                             -- JSON: pages, prompt, format...
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_user ON files (user_id, created_at);
CREATE INDEX IF NOT EXISTS files_chat ON files (chat_id);

-- Connected apps (Google, Microsoft): the services allowed and the OAuth
-- tokens, encrypted with CONNECTIONS_KEY.
CREATE TABLE IF NOT EXISTS connections (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,                -- google | microsoft
  account TEXT,                          -- the connected account's email
  services TEXT NOT NULL,                -- JSON: drive, gmail, calendar | mail, calendar, files
  tokens TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS connect_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  app TEXT NOT NULL,
  verifier TEXT NOT NULL,
  next TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Stripe webhook events already handled.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Why people cancel (also sent to Stripe as cancellation feedback); shown on the owner's Spend page.
CREATE TABLE IF NOT EXISTS cancellations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  reason TEXT NOT NULL,                  -- too_expensive | unused | missing_features | low_quality | too_complex | switched_service | customer_service | other
  comment TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cancellations_time ON cancellations (created_at);

-- Lumio Sync: records encrypted on the devices with the account's sync key
-- (the server stores ciphertext, opaque ids and collection names). In managed
-- mode, sync_keys also holds that key, wrapped. Replacing a row gives it a new
-- seq, which is how devices find what changed.
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
-- Each account's sync mode and, in managed mode, its sync key wrapped with
-- SYNC_MASTER_KEY (src/sync-keys.ts, docs/sync-managed.md). No row: managed.
CREATE TABLE IF NOT EXISTS sync_keys (
  owner TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'managed',  -- managed | passphrase (kept by DELETE /api/sync and reset)
  wrapped TEXT,                          -- 'v1.<b64 iv>.<b64 ct>', AES-256-GCM, AAD 'lumio-sync-key|v1|<owner>'; NULL in passphrase mode, after a reset or delete, or while waiting for migration
  key_check TEXT,                        -- the wrapped key's check (equals sync_meta.key_check when usable)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Key reads and changes, for their rate limits (kept an hour).
CREATE TABLE IF NOT EXISTS sync_key_events (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- 'read' (key handed out, including auto-approved pairings) | 'write' (upload, mode change, reset)
  ip_hash TEXT NOT NULL,                 -- first 32 hex of SHA-256 of 'lumio-sync|' + ipKey(cf-connecting-ip)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_key_events_owner ON sync_key_events (owner, kind, created_at);
CREATE INDEX IF NOT EXISTS sync_key_events_ip ON sync_key_events (ip_hash, kind, created_at);
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
  created_at INTEGER NOT NULL,
  challenge TEXT                         -- the iPhone and iPad app's PKCE challenge (its code needs the verifier)
);

-- One-time plan codes made on /admin: a month of a plan, no payment. Stored by hash.
CREATE TABLE IF NOT EXISTS plan_codes (
  code_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  hint TEXT NOT NULL,          -- the last 4 characters, to tell codes apart
  created_at INTEGER NOT NULL,
  redeemed_by TEXT,            -- users.id
  redeemed_at INTEGER,
  plan_until INTEGER
);

-- Reports from Lumio Browser's Help › Report an issue… (src/feedback.ts). Only
-- what the person chose to include; deleted after 180 days.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT,                -- users.id when signed in
  sender TEXT NOT NULL,        -- 'u:<user id>' or 'ip:<hash>', for the hourly limit
  email TEXT,                  -- to reply to, if they gave one
  description TEXT NOT NULL,
  url TEXT,                    -- the page, if they ticked it
  screenshot TEXT,             -- a data: URL, if they ticked it
  system TEXT,                 -- JSON: versions and OS, if they left it ticked
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_sender ON feedback (sender, created_at);
CREATE INDEX IF NOT EXISTS feedback_time ON feedback (created_at);
-- Crash reports from Lumio Browser (opt-in; src/crashes.ts). No account or
-- install ID: just the Lumio version, system and what crashed. Minidumps are
-- in R2 at crashes/<date>/<id>.dmp. Kept 90 days; ip_hash (for the per-IP
-- limit, salted with the day) is cleared after a day.
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
  ip_hash TEXT,
  dump_bytes INTEGER NOT NULL DEFAULT 0  -- for the daily storage budget
);
CREATE INDEX IF NOT EXISTS crashes_created ON crashes (created_at);
CREATE INDEX IF NOT EXISTS crashes_ip ON crashes (ip_hash, created_at);
-- Every POST /api/crash, kept or refused, for the per-IP limit (cleared after a day).
CREATE TABLE IF NOT EXISTS crash_attempts (
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crash_attempts_ip ON crash_attempts (ip_hash, created_at);

-- Email + password sign-in (src/email-auth.ts): codes waiting to be entered.
-- A sign-up isn't an account until its code is confirmed; until then it's
-- only this row.
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT NOT NULL,                   -- trimmed, lowercase
  purpose TEXT NOT NULL,                 -- 'signup' | 'reset'
  code_hash TEXT NOT NULL,               -- HMAC-SHA256 hex, keyed with the CODE_KEY Worker secret, of 'lumio-code|<purpose>|<email>|<code>'
  expires_at INTEGER NOT NULL,           -- when the code stops working (sent + 15 minutes)
  tries INTEGER NOT NULL DEFAULT 0,      -- entries of this code; at 5 it stops working
  password_hash TEXT,                    -- signup only: the chosen password, same format as users.password_hash
  created_at INTEGER NOT NULL,           -- a sign-up is forgotten 24 hours after this
  PRIMARY KEY (email, purpose)
);
CREATE INDEX IF NOT EXISTS email_codes_created ON email_codes (created_at);
-- Sends, sign-ins and codes entered, for the limits per email and per network address (kept an hour),
-- and the sends that went ahead ('mail', kept a day), for the daily cap per email and the hourly cap on all.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id TEXT PRIMARY KEY,                   -- random (randomHex(12)), so an attempt that worked can delete its own row
  kind TEXT NOT NULL,                    -- 'send' | 'signin' | 'code' | 'mail' (a send within its limits; no ip_hash)
  email_hash TEXT NOT NULL,              -- SHA-256 hex of 'lumio-email|<email>'
  ip_hash TEXT NOT NULL,                 -- first 32 hex of SHA-256 of 'lumio-auth|' + ipKey(cf-connecting-ip) (an IPv6 address counts as its /64)
  created_at INTEGER NOT NULL            -- rows are kept for one hour ('mail' rows for a day)
);
CREATE INDEX IF NOT EXISTS auth_attempts_email ON auth_attempts (kind, email_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_attempts_ip ON auth_attempts (kind, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_attempts_kind_time ON auth_attempts (kind, created_at);
