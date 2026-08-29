CREATE TABLE IF NOT EXISTS scheduler_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('running', 'ok', 'idle', 'error')),
  battle_id TEXT,
  last_started_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_cache_updated
  ON username_cache (updated_at DESC);
