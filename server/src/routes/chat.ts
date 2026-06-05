import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { providerForModel } from "@brandon/shared";
import { getProfile } from "../db/profiles.js";
import { getUserDefaults } from "../db/users.js";
import { findActiveSessionForProfile } from "../db/sessions.js";
import { streamCompletion as streamAnthropic } from "../claude/client.js";
import { streamCompletion as streamOpenAI } from "../openai/client.js";
import { streamCompletion as streamGemini } from "../gemini/client.js";
import { requireActive } from "../auth/guards.js";
import { isAllowedOrigin } from "../cors.js";

const ChatBody = z.object({
  profileId: z.string(),
  transcriptWindow: z.string(),
  userIntent: z.string().optional(),
  priorTurns: z.array(z.object({
    user: z.string(),
    assistant: z.string(),
  })).optional(),
  images: z.array(z.object({
    mediaType: z.string(),
    data: z.string(),
  })).optional(),
});

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/chat", async (req, reply) => {
    // Pending/disabled users can't spend the operator's LLM budget.
    if (requireActive(req, reply)) return;
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const profile = getProfile(parsed.data.profileId, req.user!.id);
    if (!profile) return reply.notFound("Profile not found");

    // @fastify/cors normally sets these via reply.header(), but reply.raw.writeHead
    // bypasses that — so we copy the CORS headers across by hand, using the SAME
    // allowlist as the plugin (don't blindly echo the request's Origin).
    const origin = (req.headers.origin as string) || "";
    const corsHeaders: Record<string, string> = {};
    if (origin && isAllowedOrigin(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
      corsHeaders["Vary"] = "Origin";
    }
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders,
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Look up per-interview context (target company + job description) from the
    // most recent unended session for this profile. Set in the pre-interview modal.
    const activeSession = findActiveSessionForProfile(profile.id, req.user!.id);
    const defaults = getUserDefaults(req.user!.id);
    // Dispatch to the right provider's streamer based on the profile's chosen model.
    const provider = providerForModel(profile.model);
    const stream =
      provider === "openai" ? streamOpenAI :
      provider === "gemini" ? streamGemini :
      streamAnthropic;
    try {
      await stream({
        profile,
        transcriptWindow: parsed.data.transcriptWindow,
        userIntent: parsed.data.userIntent,
        priorTurns: parsed.data.priorTurns ?? [],
        images: parsed.data.images,
        defaults,
        sessionContext: activeSession
          ? { targetCompany: activeSession.targetCompany, jobDescription: activeSession.jobDescription }
          : undefined,
        onText: (text) => send("chunk", { type: "text", text }),
        onTool: (evt) => send("chunk", { type: "tool", ...evt }),
        onDone: (usage) => send("done", { type: "done", usage }),
      });
    } catch (err) {
      app.log.error({ err }, "chat stream failed");
      send("chunk", { type: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });
}
