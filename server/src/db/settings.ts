import { db } from "./client.js";

interface Row { key: string; value: string; updated_at: number; }

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

/** Read the user-saved Anthropic key from settings, falling back to env. */
export function getAnthropicKey(): string {
  return getSetting("anthropicApiKey") ?? process.env.ANTHROPIC_API_KEY ?? "";
}

/** Read the user-saved OpenAI key from settings, falling back to env. */
export function getOpenAIKey(): string {
  return getSetting("openaiApiKey") ?? process.env.OPENAI_API_KEY ?? "";
}

/** Read the user-saved Google Gemini key from settings, falling back to env. */
export function getGeminiKey(): string {
  return getSetting("geminiApiKey") ?? process.env.GEMINI_API_KEY ?? "";
}

export function isKeySet(): boolean {
  return getAnthropicKey().trim().length > 0;
}

/** Global default interview brief, applied to every profile (per-profile briefs
 *  append to this). Lets the user set their background once. */
export function getDefaultBrief(): string {
  return getSetting("defaultInterviewBrief") ?? "";
}

/** Global default voice sample applied to every profile. A per-profile voice
 *  sample, if set, takes precedence (the user wants distinct tones per mode). */
export function getDefaultVoiceSample(): string {
  return getSetting("defaultVoiceSample") ?? "";
}
export function isOpenAIKeySet(): boolean {
  return getOpenAIKey().trim().length > 0;
}
export function isGeminiKeySet(): boolean {
  return getGeminiKey().trim().length > 0;
}
