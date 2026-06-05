import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  isKeySet, isOpenAIKeySet, isGeminiKeySet,
  getProviderKeyInfo, setProviderKey, type Provider,
} from "../db/settings.js";
import { getUserDefaults, setUserDefaults } from "../db/users.js";
import { getUserUsageTotals } from "../db/usage.js";
import { requireActive, requireSuperadmin } from "../auth/guards.js";

const PROVIDERS: Provider[] = ["anthropic", "openai", "gemini"];

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Which providers the SERVER has keys for (boolean only — no key material).
  // Every authenticated user can read this so the UI shows which models work.
  app.get("/settings/status", async () => ({
    anthropicKeySet: isKeySet(),
    openaiKeySet: isOpenAIKeySet(),
    geminiKeySet: isGeminiKeySet(),
  }));

  // --- Admin: view + set the shared provider keys (redacted on read) ---
  app.get("/settings/keys", async (req, reply) => {
    if (requireSuperadmin(req, reply)) return;
    return Object.fromEntries(PROVIDERS.map((p) => [p, getProviderKeyInfo(p)]));
  });

  const PutKeyBody = z.object({
    provider: z.enum(["anthropic", "openai", "gemini"]),
    key: z.string().nullable(), // null/empty clears (→ falls back to env seed)
  });
  app.put("/settings/keys", async (req, reply) => {
    if (requireSuperadmin(req, reply)) return;
    const parsed = PutKeyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const { provider, key } = parsed.data;
    // Light prefix sanity-check (don't hard-fail Gemini which varies).
    const k = key?.trim();
    if (k && provider === "anthropic" && !k.startsWith("sk-ant-")) {
      return reply.badRequest("Anthropic keys start with sk-ant-");
    }
    if (k && provider === "openai" && !k.startsWith("sk-")) {
      return reply.badRequest("OpenAI keys start with sk-");
    }
    setProviderKey(provider, k ?? null);
    return getProviderKeyInfo(provider);
  });

  // Per-user defaults — voice sample + interview brief applied to all of THIS
  // user's profiles. Per-profile values take precedence (voice) / append (brief).
  app.get("/settings/defaults", async (req) => getUserDefaults(req.user!.id));

  const PutDefaultsBody = z.object({
    defaultInterviewBrief: z.string().optional(),
    defaultVoiceSample: z.string().optional(),
  });
  app.put("/settings/defaults", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const parsed = PutDefaultsBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    return setUserDefaults(req.user!.id, parsed.data);
  });

  // A user's OWN usage totals (anyone can see their own).
  app.get("/settings/usage", async (req) => getUserUsageTotals(req.user!.id));
}
