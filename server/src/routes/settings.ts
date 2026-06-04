import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAnthropicKey, isKeySet, setSetting, deleteSetting } from "../db/settings.js";

const PutKeyBody = z.object({
  anthropicApiKey: z.string().trim().nullable(),
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

  // Convenience: ask the server if the key is set (used by the Home banner).
  app.get("/settings/status", async () => ({ anthropicKeySet: isKeySet() }));
}
