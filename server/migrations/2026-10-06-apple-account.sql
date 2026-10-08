-- 2026-10-06: Lumio for iPhone and iPad. Sign in with Apple (POST
-- /api/auth/apple), the app's PKCE sign-in hand-off (POST /api/auth/app/token)
-- and deleting an account in the app (DELETE /api/account). Same as schema.sql.
-- Run once:  npx wrangler d1 execute lumio --remote --file migrations/2026-10-06-apple-account.sql
ALTER TABLE users ADD COLUMN apple_sub TEXT;
ALTER TABLE users ADD COLUMN apple_refresh TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_apple ON users (apple_sub);
ALTER TABLE app_codes ADD COLUMN challenge TEXT;
