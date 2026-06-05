import { config } from "../config.js";
import { db } from "./client.js";

// Generic key-value settings store (the `settings` table). Used for the shared,
// admin-editable LLM provider keys. Keys live in the DB so a super-admin can set
// them from the UI; the server env vars act as an initial seed/fallback.
interface Row { value: string; }

export function getSetting(key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  return r ? r.value : null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// Provider keys: DB value wins; fall back to the env seed. The operator owns
// these (one shared set, the operator pays). The provider clients are unchanged
// — they call getAnthropicKey()/etc.; the source is now DB-then-env.
export function getAnthropicKey(): string { return getSetting("anthropicApiKey") ?? config.anthropicApiKey ?? ""; }
export function getOpenAIKey(): string { return getSetting("openaiApiKey") ?? config.openaiApiKey ?? ""; }
export function getGeminiKey(): string { return getSetting("geminiApiKey") ?? config.geminiApiKey ?? ""; }

export function isKeySet(): boolean { return getAnthropicKey().trim().length > 0; }
export function isOpenAIKeySet(): boolean { return getOpenAIKey().trim().length > 0; }
export function isGeminiKeySet(): boolean { return getGeminiKey().trim().length > 0; }

export type Provider = "anthropic" | "openai" | "gemini";
const KEY_SETTING: Record<Provider, string> = {
  anthropic: "anthropicApiKey",
  openai: "openaiApiKey",
  gemini: "geminiApiKey",
};

/** Admin sets/clears a provider key in the DB. Empty string clears it (→ falls
 *  back to the env seed if any). */
export function setProviderKey(provider: Provider, key: string | null): void {
  const settingKey = KEY_SETTING[provider];
  const v = key?.trim();
  if (v) setSetting(settingKey, v);
  else deleteSetting(settingKey);
}

const GETTERS: Record<Provider, () => string> = {
  anthropic: getAnthropicKey,
  openai: getOpenAIKey,
  gemini: getGeminiKey,
};

/** Redacted view for the admin UI — never returns the full key. `source`
 *  distinguishes a DB-set key from one inherited from the env seed. */
export function getProviderKeyInfo(provider: Provider): { set: boolean; preview: string | null; source: "db" | "env" | "none" } {
  const dbVal = getSetting(KEY_SETTING[provider]);
  const effective = GETTERS[provider]().trim();
  if (!effective) return { set: false, preview: null, source: "none" };
  return { set: true, preview: `…${effective.slice(-4)}`, source: dbVal ? "db" : "env" };
}
