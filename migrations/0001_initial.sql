CREATE TABLE IF NOT EXISTS clan_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL,
  clan_name TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data_json TEXT NOT NULL,
  signature TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clan_snapshots_battle_clan_time
  ON clan_snapshots (battle_id, clan_name, timestamp);

CREATE TABLE IF NOT EXISTS clan_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL,
  clan_name TEXT NOT NULL,
  change_type TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clan_changes_battle_clan
  ON clan_changes (battle_id, clan_name, id);

CREATE TABLE IF NOT EXISTS tracked_clans (
  battle_id TEXT NOT NULL,
  clan_name TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (battle_id, clan_name)
);

CREATE INDEX IF NOT EXISTS idx_tracked_clans_battle_added
  ON tracked_clans (battle_id, added_at);

CREATE TABLE IF NOT EXISTS battle_state (
  battle_id TEXT PRIMARY KEY,
  update_cursor INTEGER NOT NULL DEFAULT 0,
  end_time INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS username_cache (
  clan_name TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_cache_expires
  ON username_cache (expires_at);
