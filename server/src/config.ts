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

// Local API key — used by the Electron client to authenticate against the
// loopback server. In production the Electron process generates one and passes
// it via env. In dev we persist a stable key in the data dir so reloads don't
// invalidate the client.
function ensureLocalApiKey(): string {
  const fromEnv = process.env.BRANDON_API_KEY?.trim();
  if (fromEnv && fromEnv !== "change-me-to-a-random-string") return fromEnv;

  const keyFile = resolve(DATA_DIR, "brandon-api-key");
  if (existsSync(keyFile)) {
    const persisted = readFileSync(keyFile, "utf8").trim();
    if (persisted) { process.env.BRANDON_API_KEY = persisted; return persisted; }
  }
  const generated = randomBytes(24).toString("hex");
  writeFileSync(keyFile, generated, "utf8");
  process.env.BRANDON_API_KEY = generated;
  return generated;
}

// When PORT is unset we bind to 0 so the OS hands us a free port — this avoids
// dev collisions with other local services. The actual bound port is written
// to <dataDir>/brandon-port after listen() so the desktop shell can discover it.
const portEnv = process.env.PORT?.trim();
export const config = {
  port: portEnv ? Number(portEnv) : 0,
  apiKey: ensureLocalApiKey(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  extendedCache: process.env.BRANDON_EXTENDED_CACHE === "true",
  dataDir: DATA_DIR,
  dbPath: DB_PATH,
  uploadsDir: UPLOADS_DIR,
};
