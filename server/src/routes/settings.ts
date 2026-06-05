import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  deleteSetting,
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getDefaultBrief,
  getDefaultVoiceSample,
  isKeySet,
  isOpenAIKeySet,
  isGeminiKeySet,
  setSetting,
} from "../db/settings.js";

const PutKeyBody = z.object({ apiKey: z.string().trim().nullable() });

interface KeyEndpointConfig {
  path: string;
  storageKey: string;
  prefixCheck?: { prefix: string; hint: string };
  getter: () => string;
}

const ENDPOINTS: KeyEndpointConfig[] = [
  { path: "/settings/anthropic", storageKey: "anthropicApiKey",
    prefixCheck: { prefix: "sk-ant-", hint: "Anthropic keys start with sk-ant-" },
    getter: getAnthropicKey },
  { path: "/settings/openai", storageKey: "openaiApiKey",
    prefixCheck: { prefix: "sk-", hint: "OpenAI keys start with sk-" },
    getter: getOpenAIKey },
  { path: "/settings/gemini", storageKey: "geminiApiKey",
    // Google AI Studio keys start with "AIza" but Vertex/service keys vary;
    // don't enforce a prefix.
    getter: getGeminiKey },
];

function redact(key: string): string { return `…${key.slice(-4)}`; }

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  for (const ep of ENDPOINTS) {
    app.get(ep.path, async () => {
      const k = ep.getter();
      return k ? { set: true, preview: redact(k) } : { set: false, preview: null };
    });
    app.put(ep.path, async (req, reply) => {
      const parsed = PutKeyBody.safeParse(req.body);
      if (!parsed.success) return reply.badRequest(parsed.error.message);
      const k = parsed.data.apiKey?.trim();
      if (!k) { deleteSetting(ep.storageKey); return { set: false, preview: null }; }
      if (ep.prefixCheck && !k.startsWith(ep.prefixCheck.prefix)) {
        return reply.badRequest(ep.prefixCheck.hint);
      }
      setSetting(ep.storageKey, k);
      return { set: true, preview: redact(k) };
    });
  }

  app.get("/settings/status", async () => ({
    anthropicKeySet: isKeySet(),
    openaiKeySet: isOpenAIKeySet(),
    geminiKeySet: isGeminiKeySet(),
  }));

  // --- Global defaults — voice sample + interview brief applied to every profile. ---
  // Per-profile values, when set, take precedence over the voice sample default;
  // per-profile briefs APPEND after the global brief. Lets the user enter
  // background / persona info once instead of per-profile.
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
}
