-- Users (multi-tenant). Each row is an account; super-admin approves new signups.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  -- lower(trim(email)) for case-insensitive uniqueness; PG-portable (no COLLATE).
  email_key     TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- "scrypt$N$r$p$saltB64$hashB64"
  role          TEXT NOT NULL DEFAULT 'user',     -- 'user' | 'superadmin'
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'disabled'
  default_interview_brief TEXT,         -- per-user default (moved off global settings)
  default_voice_sample    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_status_idx ON users(status);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT,
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

-- NOTE: user_id indexes (profiles_user_idx, profiles_active_unique,
-- companies_user_idx, companies_user_name_idx, sessions_user_idx) are created in
-- client.ts AFTER the migration adds the user_id column — they can't live here
-- because on an existing DB this file runs before that column exists.

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

-- One row per chat call, for per-user usage accounting (admins see all, users
-- see their own). Tokens come from the provider's usage report on stream end.
CREATE TABLE IF NOT EXISTS usage_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,            -- 'anthropic' | 'openai' | 'gemini'
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_log_user_idx ON usage_log(user_id);
CREATE INDEX IF NOT EXISTS usage_log_created_idx ON usage_log(created_at DESC);

-- Practice/prep chats (ChatGPT-style). Per-user; each has an ordered message
-- list. Separate from interview `sessions` (which are live-caption transcripts).
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_id TEXT,                   -- the mode whose model+persona answers
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
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
  user_id TEXT,
  name TEXT NOT NULL,
  -- Case-insensitive canonical form for dedupe (lower-cased, trimmed).
  name_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'rejected' | 'offer'
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(status);
CREATE INDEX IF NOT EXISTS companies_updated_idx ON companies(updated_at DESC);
