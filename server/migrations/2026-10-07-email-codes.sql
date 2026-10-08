-- 2026-10-07: email + password sign-in (src/email-auth.ts). Same as schema.sql.
-- Run once:  npx wrangler d1 execute lumio --remote --file migrations/2026-10-07-email-codes.sql
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, purpose)
);
CREATE INDEX IF NOT EXISTS email_codes_created ON email_codes (created_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_email ON auth_attempts (kind, email_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_attempts_ip ON auth_attempts (kind, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_attempts_kind_time ON auth_attempts (kind, created_at);
