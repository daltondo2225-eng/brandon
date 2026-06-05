import { config as loadDotenv } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// In dev the repo .env at `c:\Brandon\.env` is convenient. In production the
// server runs from inside the Electron resources dir and the data dir is
// %APPDATA%\Brandon — there is no .env. dotenv is harmless either way.
const DEV_ENV_PATH = resolve(process.cwd(), "../.env");
if (existsSync(DEV_ENV_PATH)) loadDotenv({ path: DEV_ENV_PATH });

// BRANDON_DATA_DIR is set by the Electron main process when the server is
// spawned in a packaged build. In dev it defaults to <server>/data so existing
// development workflows are unchanged.
const DATA_DIR = process.env.BRANDON_DATA_DIR
  ? resolve(process.env.BRANDON_DATA_DIR)
  : resolve(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const UPLOADS_DIR = resolve(DATA_DIR, "uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });

const DB_PATH = resolve(DATA_DIR, "brandon.db");

// JWT signing secret. MUST be set via BRANDON_JWT_SECRET in production (a
// known/committed secret = token forgery = account takeover). For local dev we
// persist a random secret in the data dir so sessions survive restarts, and
// warn loudly that prod must provide its own.
function ensureJwtSecret(): string {
  const fromEnv = process.env.BRANDON_JWT_SECRET?.trim();
  if (fromEnv) return fromEnv;

  const file = resolve(DATA_DIR, "jwt-secret");
  if (existsSync(file)) {
    const persisted = readFileSync(file, "utf8").trim();
    if (persisted) return persisted;
  }
  const generated = randomBytes(48).toString("hex");
  writeFileSync(file, generated, "utf8");
  console.warn(
    "[brandon] BRANDON_JWT_SECRET not set — generated a local dev secret. " +
    "Set BRANDON_JWT_SECRET explicitly in production.",
  );
  return generated;
}

// Comma-separated allowlist of extra CORS origins (e.g. a LAN client URL).
const allowedOrigins = (process.env.BRANDON_ALLOWED_ORIGINS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  // Bind host: 127.0.0.1 for local-only; set BRANDON_HOST=0.0.0.0 to expose on LAN / a host.
  host: process.env.BRANDON_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  jwtSecret: ensureJwtSecret(),
  // LLM provider keys are now SERVER-owned (the operator pays). From env only.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  extendedCache: process.env.BRANDON_EXTENDED_CACHE === "true",
  // First-boot super-admin (created + owns pre-existing data by bootstrap.ts).
  superadminEmail: process.env.BRANDON_SUPERADMIN_EMAIL?.trim() ?? "",
  superadminPassword: process.env.BRANDON_SUPERADMIN_PASSWORD ?? "",
  allowedOrigins,
  dataDir: DATA_DIR,
  dbPath: DB_PATH,
  uploadsDir: UPLOADS_DIR,
};
