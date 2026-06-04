CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  realtime_prompt TEXT NOT NULL DEFAULT '',
  notes_template TEXT,
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  is_active INTEGER NOT NULL DEFAULT 0,
  full_name TEXT,
  job_title TEXT,
  company TEXT,
  location TEXT,
  voice_sample TEXT,
  interview_brief TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_active_unique
  ON profiles(is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS reference_files (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reference_files_profile_idx
  ON reference_files(profile_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  transcript TEXT,
  recap TEXT,
  target_company TEXT,
  job_description TEXT
);

CREATE INDEX IF NOT EXISTS sessions_profile_idx ON sessions(profile_id);
CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions(started_at DESC);

-- Companies: one row per opportunity / employer the user is interviewing with.
-- Status is user-managed; the rest is aggregated from the company's sessions.
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Case-insensitive canonical form for dedupe (lower-cased, trimmed).
  name_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'rejected' | 'offer'
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(status);
CREATE INDEX IF NOT EXISTS companies_updated_idx ON companies(updated_at DESC);
