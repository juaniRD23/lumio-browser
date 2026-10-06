-- How long each AI call took, and which model answered (src/usage.ts settle).
-- schema.sql already has both columns. SQLite has no ADD COLUMN IF NOT
-- EXISTS, so this is the one migration that can't run twice: on a database
-- that has them it stops with "duplicate column name: ms", which is harmless.
ALTER TABLE steps ADD COLUMN ms INTEGER;
ALTER TABLE steps ADD COLUMN model TEXT;
