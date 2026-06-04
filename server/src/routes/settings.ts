import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getAnthropicKey, getOpenAIKey, getGeminiKey,
  getDefaultBrief, getDefaultVoiceSample,
  isKeySet, isOpenAIKeySet, isGeminiKeySet, setSetting, deleteSetting,
} from "../db/settings.js";

const PutKeyBody = z.object({
  anthropicApiKey: z.string().trim().nullable(),
});

const PutOpenAIKeyBody = z.object({
  openaiApiKey: z.string().trim().nullable(),
});

const PutGeminiKeyBody = z.object({
  geminiApiKey: z.string().trim().nullable(),
});

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Returns whether the key is set + a redacted preview (never the full key).
  app.get("/settings/anthropic", async () => {
    const key = getAnthropicKey();
    if (!key) return { set: false, preview: null };
    const last4 = key.slice(-4);
    return { set: true, preview: `…${last4}` };
  });

  // Set or clear the Anthropic API key.
  app.put("/settings/anthropic", async (req, reply) => {
    const parsed = PutKeyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const k = parsed.data.anthropicApiKey?.trim();
    if (!k) { deleteSetting("anthropicApiKey"); return { set: false, preview: null }; }
    if (!k.startsWith("sk-ant-")) return reply.badRequest("Key should start with sk-ant-");
    setSetting("anthropicApiKey", k);
    return { set: true, preview: `…${k.slice(-4)}` };
  });

  // --- OpenAI key (mirrors the Anthropic endpoints) ---
  app.get("/settings/openai", async () => {
    const key = getOpenAIKey();
    if (!key) return { set: false, preview: null };
    return { set: true, preview: `…${key.slice(-4)}` };
  });

  app.put("/settings/openai", async (req, reply) => {
    const parsed = PutOpenAIKeyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const k = parsed.data.openaiApiKey?.trim();
    if (!k) { deleteSetting("openaiApiKey"); return { set: false, preview: null }; }
    // OpenAI keys start with "sk-" (sk-, sk-proj-, etc.) but not "sk-ant-".
    if (!k.startsWith("sk-") || k.startsWith("sk-ant-")) {
      return reply.badRequest("OpenAI key should start with sk- (not sk-ant-)");
    }
    setSetting("openaiApiKey", k);
    return { set: true, preview: `…${k.slice(-4)}` };
  });

  // --- Google Gemini key (mirrors the others) ---
  app.get("/settings/gemini", async () => {
    const key = getGeminiKey();
    if (!key) return { set: false, preview: null };
    return { set: true, preview: `…${key.slice(-4)}` };
  });

  app.put("/settings/gemini", async (req, reply) => {
    const parsed = PutGeminiKeyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const k = parsed.data.geminiApiKey?.trim();
    if (!k) { deleteSetting("geminiApiKey"); return { set: false, preview: null }; }
    // Google AI Studio keys start with "AIza".
    if (!k.startsWith("AIza")) return reply.badRequest("Gemini key should start with AIza");
    setSetting("geminiApiKey", k);
    return { set: true, preview: `…${k.slice(-4)}` };
  });

  // --- Global defaults (applied to every profile) ---
  // The default brief + voice sample so the user enters their "normal" personal
  // info / tone ONCE instead of per-profile.
  app.get("/settings/defaults", async () => ({
    defaultInterviewBrief: getDefaultBrief(),
    defaultVoiceSample: getDefaultVoiceSample(),
  }));

  const PutDefaultsBody = z.object({
    defaultInterviewBrief: z.string().optional(),
    defaultVoiceSample: z.string().optional(),
  });
  app.put("/settings/defaults", async (req, reply) => {
    const parsed = PutDefaultsBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    if (parsed.data.defaultInterviewBrief !== undefined) {
      const v = parsed.data.defaultInterviewBrief.trim();
      if (v) setSetting("defaultInterviewBrief", v);
      else deleteSetting("defaultInterviewBrief");
    }
    if (parsed.data.defaultVoiceSample !== undefined) {
      const v = parsed.data.defaultVoiceSample.trim();
      if (v) setSetting("defaultVoiceSample", v);
      else deleteSetting("defaultVoiceSample");
    }
    return { defaultInterviewBrief: getDefaultBrief(), defaultVoiceSample: getDefaultVoiceSample() };
  });

  // Convenience: ask the server if the keys are set (used by the Home banner).
  app.get("/settings/status", async () => ({
    anthropicKeySet: isKeySet(),
    openaiKeySet: isOpenAIKeySet(),
    geminiKeySet: isGeminiKeySet(),
  }));
}
