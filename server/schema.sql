-- Lumio (lumio-usa.online) on Cloudflare D1. Safe to run again (IF NOT EXISTS).

-- Accounts: signed in with Google. The plan comes from the Stripe subscription.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  plan TEXT NOT NULL DEFAULT 'free',     -- free | go | plus | pro | max
  plan_status TEXT,                      -- Stripe subscription status, or 'code' (a month from a plan code)
  plan_renews_at INTEGER,
  subscription_id TEXT,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL,
  role TEXT                              -- 'owner' can see the Spend page
);
CREATE INDEX IF NOT EXISTS users_customer ON users (stripe_customer_id);

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
  collection TEXT NOT NULL,              -- bookmarks | passwords | history | chats | workflows | settings | tabs
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
