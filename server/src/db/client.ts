import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.uploadsDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// schema.sql lives next to this file in dev (src/db/schema.sql) but next to the
// bundled entrypoint in production. Try both before giving up.
function readSchema(): string {
  const candidates = [
    resolve(__dirname, "schema.sql"),
    resolve(__dirname, "..", "schema.sql"),
    resolve(__dirname, "db", "schema.sql"),
  ];
  for (const p of candidates) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  throw new Error(`schema.sql not found in any of: ${candidates.join(", ")}`);
}
db.exec(readSchema());

// Migrations — add columns that were introduced after the initial schema.
for (const col of ["full_name", "job_title", "company", "location", "voice_sample", "interview_brief", "repo_root"]) {
  try { db.exec(`ALTER TABLE profiles ADD COLUMN ${col} TEXT`); }
  catch { /* column already exists */ }
}
try { db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''`); }
catch { /* column already exists */ }
for (const col of ["transcript", "recap", "target_company", "job_description"]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`); }
  catch { /* column already exists */ }
}
try { db.exec(`ALTER TABLE sessions ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL`); }
catch { /* column already exists */ }
try { db.exec(`CREATE INDEX IF NOT EXISTS sessions_company_idx ON sessions(company_id)`); }
catch { /* ignore */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN next_steps_json TEXT`); }
catch { /* column already exists */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN prior_turns_json TEXT`); }
catch { /* column already exists */ }

// ── Multi-tenant migration ────────────────────────────────────────────────
// 1. Add nullable user_id to the owned tables (+ index). Nullable so existing
//    rows survive; ownership is enforced in the accessor layer and the rows are
//    backfilled to the super-admin by bootstrap.ts.
for (const t of ["profiles", "sessions", "companies"]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN user_id TEXT`); }
  catch { /* column already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS ${t}_user_idx ON ${t}(user_id)`); }
  catch { /* ignore */ }
}

// 2. The two pre-multi-tenant UNIQUE constraints were GLOBAL and must become
//    per-user. SQLite can't ALTER away an inline column UNIQUE or redefine a
//    partial index in place, so detect the legacy shape and rebuild once.
function indexNames(table: string): string[] {
  try {
    return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
      .map((r) => r.name);
  } catch { return []; }
}

// 2a. profiles: replace global `profiles_active_unique` (on is_active only) with
//     a per-user one. We detect "old" by checking the indexed columns.
function indexCols(name: string): string[] {
  try {
    return (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>)
      .map((r) => r.name);
  } catch { return []; }
}
{
  const cols = indexCols("profiles_active_unique");
  // Old shape indexes only [is_active]; new shape indexes [user_id, is_active].
  if (cols.length && !cols.includes("user_id")) {
    try {
      db.exec("DROP INDEX IF EXISTS profiles_active_unique");
      db.exec(
        "CREATE UNIQUE INDEX profiles_active_unique ON profiles(user_id, is_active) WHERE is_active = 1",
      );
    } catch { /* leave as-is on failure; schema.sql creates the new one on fresh DBs */ }
  }
}

// 2b. companies: the legacy table had `name_key TEXT NOT NULL UNIQUE` (a global
//     auto-index). Rebuild the table without the inline UNIQUE and add a
//     per-user composite unique index. Detect by the presence of an
//     auto-index on companies that isn't our named per-user one.
{
  const names = indexNames("companies");
  const hasPerUser = names.includes("companies_user_name_idx");
  const hasLegacyAuto = names.some((n) => n.startsWith("sqlite_autoindex_companies"));
  if (hasLegacyAuto && !hasPerUser) {
    tx(() => {
      db.exec(`CREATE TABLE companies_new (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.exec(`INSERT INTO companies_new (id, user_id, name, name_key, status, notes, created_at, updated_at)
               SELECT id, user_id, name, name_key, status, notes, created_at, updated_at FROM companies`);
      db.exec("DROP TABLE companies");
      db.exec("ALTER TABLE companies_new RENAME TO companies");
      db.exec("CREATE INDEX IF NOT EXISTS companies_user_idx ON companies(user_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS companies_user_name_idx ON companies(user_id, name_key)");
      db.exec("CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(status)");
      db.exec("CREATE INDEX IF NOT EXISTS companies_updated_idx ON companies(updated_at DESC)");
    });
  }
}

// 3. Ensure the per-user indexes exist on FRESH DBs too (schema.sql can't create
//    them — it runs before user_id is added). Idempotent; the 2a/2b branches
//    above handle migrating legacy global constraints, this covers new installs.
db.exec("CREATE INDEX IF NOT EXISTS profiles_user_idx ON profiles(user_id)");
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS profiles_active_unique ON profiles(user_id, is_active) WHERE is_active = 1");
} catch { /* a legacy global index may still hold the name; 2a handles that case */ }
db.exec("CREATE INDEX IF NOT EXISTS companies_user_idx ON companies(user_id)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS companies_user_name_idx ON companies(user_id, name_key)");

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
