import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { app, safeStorage } from "electron";

// Brandon is now a CLIENT of a remote (or local) multi-tenant server. We no
// longer spawn a server — we just remember which server URL to talk to and
// store the user's JWT securely (OS keychain via Electron safeStorage).

// Default server URL the client points at out of the box. Local-first for v1;
// override via the login screen (persisted) or BRANDON_SERVER_URL in dev.
const DEFAULT_SERVER_URL = process.env.BRANDON_SERVER_URL ?? "http://localhost:8787";

interface ClientConfig {
  serverBase: string;
  // Encrypted JWT (base64 of safeStorage ciphertext), or a plaintext fallback.
  tokenEnc?: string;
  tokenPlain?: string;
}

function configPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "client-config.json");
}

function read(): ClientConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    return JSON.parse(raw) as ClientConfig;
  } catch {
    return { serverBase: DEFAULT_SERVER_URL };
  }
}

function write(cfg: ClientConfig): void {
  try { writeFileSync(configPath(), JSON.stringify(cfg), "utf8"); } catch { /* ignore */ }
}

export function getServerBase(): string {
  return read().serverBase || DEFAULT_SERVER_URL;
}

export function setServerBase(url: string): void {
  const cfg = read();
  cfg.serverBase = url.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  write(cfg);
}

export function getToken(): string | null {
  const cfg = read();
  if (cfg.tokenEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(cfg.tokenEnc, "base64"));
    } catch { return null; }
  }
  return cfg.tokenPlain ?? null;
}

export function setToken(token: string): void {
  const cfg = read();
  delete cfg.tokenEnc;
  delete cfg.tokenPlain;
  if (safeStorage.isEncryptionAvailable()) {
    cfg.tokenEnc = safeStorage.encryptString(token).toString("base64");
  } else {
    // Fallback when no OS keyring is available (e.g. some Linux setups).
    console.warn("[brandon] safeStorage unavailable — storing JWT in plaintext.");
    cfg.tokenPlain = token;
  }
  write(cfg);
}

export function clearToken(): void {
  const cfg = read();
  delete cfg.tokenEnc;
  delete cfg.tokenPlain;
  write(cfg);
}

export const _hasPersistedConfig = () => existsSync(configPath());
