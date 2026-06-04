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

// schema.sql lives next to this file in dev (src/db/schema.sql) and next to the
// bundled entrypoint in the Electron build. In the standalone SEA build there is
// no real file on disk relative to __dirname (it resolves into the injected
// blob's virtual path), so the SEA bundler embeds schema.sql as an asset and we
// read it via node:sea first. Filesystem candidates remain the fallback.
function readSchema(): string {
  // 1. SEA asset (standalone server.exe). node:sea is only present in an SEA
  //    runtime; guard the require so dev/Electron Node ignores it.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sea = require("node:sea") as { isSea(): boolean; getAsset(k: string, e: string): string };
    if (sea.isSea?.()) {
      return sea.getAsset("schema.sql", "utf8");
    }
  } catch { /* not running as SEA — fall through to filesystem */ }

  // 2. Filesystem (dev + Electron bundle).
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
for (const col of ["full_name", "job_title", "company", "location", "voice_sample", "interview_brief"]) {
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
