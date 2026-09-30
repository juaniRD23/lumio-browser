-- Lumio (lumio-usa.online) on Cloudflare D1. Safe to run again (IF NOT EXISTS).

-- Accounts: signed in with Google. The plan comes from the Stripe subscription.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  plan TEXT NOT NULL DEFAULT 'free',     -- free | plus | pro | max
  plan_status TEXT,                      -- Stripe subscription status
  plan_renews_at INTEGER,
  subscription_id TEXT,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL
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
  kind TEXT NOT NULL DEFAULT 'browser',  -- browser | chat
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,                  -- running | done | failed
  held_microusd INTEGER NOT NULL,
  cost_microusd INTEGER,
  result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_owner_time ON steps (owner, created_at);
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
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages (chat_id, id);

-- Stripe webhook events already handled.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
