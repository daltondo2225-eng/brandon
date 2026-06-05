import { config } from "../config.js";

// LLM provider keys are now SERVER-owned (the operator pays). They come from the
// server's env/config — NOT from per-user settings — so a logged-in user can use
// chat without ever entering a key. The provider clients are unchanged; they
// still call getAnthropicKey()/etc., the source just moved to config.
export function getAnthropicKey(): string { return config.anthropicApiKey ?? ""; }
export function getOpenAIKey(): string { return config.openaiApiKey ?? ""; }
export function getGeminiKey(): string { return config.geminiApiKey ?? ""; }

export function isKeySet(): boolean { return getAnthropicKey().trim().length > 0; }
export function isOpenAIKeySet(): boolean { return getOpenAIKey().trim().length > 0; }
export function isGeminiKeySet(): boolean { return getGeminiKey().trim().length > 0; }
