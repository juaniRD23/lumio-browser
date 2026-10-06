-- Help › Report an issue… in Lumio Browser (see src/feedback.ts).
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  sender TEXT NOT NULL,
  email TEXT,
  description TEXT NOT NULL,
  url TEXT,
  screenshot TEXT,
  system TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_sender ON feedback (sender, created_at);
CREATE INDEX IF NOT EXISTS feedback_time ON feedback (created_at);
