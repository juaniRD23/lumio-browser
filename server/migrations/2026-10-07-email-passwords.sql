-- 2026-10-07: a password on an account (email + password sign-in), and a mark on
-- accounts made with Sign in with Apple from an email Apple hadn't verified (never
-- found by that email). Same as schema.sql.
-- Run once, after 2026-10-07-email-codes.sql (ALTER can't run twice):
--   npx wrangler d1 execute lumio --remote --file migrations/2026-10-07-email-passwords.sql
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN email_unverified INTEGER;
CREATE INDEX IF NOT EXISTS users_email ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_password_email ON users (email) WHERE password_hash IS NOT NULL;
