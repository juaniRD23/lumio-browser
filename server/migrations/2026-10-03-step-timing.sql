-- How long each AI call took, and which model answered (src/usage.ts settle).
ALTER TABLE steps ADD COLUMN ms INTEGER;
ALTER TABLE steps ADD COLUMN model TEXT;
