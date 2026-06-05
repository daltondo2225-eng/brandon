import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isKeySet, isOpenAIKeySet, isGeminiKeySet } from "../db/settings.js";
import { getUserDefaults, setUserDefaults } from "../db/users.js";
import { requireActive } from "../auth/guards.js";

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Which providers the SERVER has keys for (boolean only — no key material is
  // ever exposed to clients). Lets the UI show "AI ready" / which models work.
  app.get("/settings/status", async () => ({
    anthropicKeySet: isKeySet(),
    openaiKeySet: isOpenAIKeySet(),
    geminiKeySet: isGeminiKeySet(),
  }));

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
}
