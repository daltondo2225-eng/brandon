import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatTurn } from "@brandon/shared";
import { providerForModel } from "@brandon/shared";
import {
  addMessage, createConversation, deleteConversation, getConversation,
  listConversations, listMessages, renameConversation, touchConversation,
} from "../db/conversations.js";
import { getActiveProfile, getProfile } from "../db/profiles.js";
import { getUserDefaults } from "../db/users.js";
import { logUsage } from "../db/usage.js";
import { streamCompletion as streamAnthropic } from "../claude/client.js";
import { streamCompletion as streamOpenAI } from "../openai/client.js";
import { streamCompletion as streamGemini } from "../gemini/client.js";
import { requireActive } from "../auth/guards.js";
import { isAllowedOrigin } from "../cors.js";

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/conversations", async (req) => ({ conversations: listConversations(req.user!.id) }));

  app.get<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    const conv = getConversation(req.params.id, req.user!.id);
    if (!conv) return reply.notFound("Conversation not found");
    return { conversation: conv, messages: listMessages(conv.id) };
  });

  app.post("/conversations", async (req, reply) => {
    if (requireActive(req, reply)) return;
    // Tie the chat to the user's active mode so its model+persona answer.
    const active = getActiveProfile(req.user!.id);
    const conv = createConversation(req.user!.id, active?.id ?? null);
    return reply.code(201).send(conv);
  });

  app.delete<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    if (requireActive(req, reply)) return;
    if (!deleteConversation(req.params.id, req.user!.id)) return reply.notFound("Conversation not found");
    return reply.code(204).send();
  });

  // Post a user message and stream the assistant reply (SSE). Persists both.
  const PostBody = z.object({ content: z.string().min(1) });
  app.post<{ Params: { id: string } }>("/conversations/:id/messages", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const conv = getConversation(req.params.id, req.user!.id);
    if (!conv) return reply.notFound("Conversation not found");
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    // The mode that answers: the conversation's profile, else the active one.
    const profileId = conv.profileId ?? getActiveProfile(req.user!.id)?.id ?? null;
    const profile = profileId ? getProfile(profileId, req.user!.id) : null;
    if (!profile) {
      return reply.badRequest("No active mode — set one as Active to chat.");
    }

    // Prior messages → priorTurns (pairs of user/assistant).
    const prior = listMessages(conv.id);
    const priorTurns: ChatTurn[] = [];
    for (let i = 0; i < prior.length; i++) {
      if (prior[i].role === "user" && prior[i + 1]?.role === "assistant") {
        priorTurns.push({ user: prior[i].content, assistant: prior[i + 1].content });
        i++;
      }
    }

    // Persist the user message + auto-title from the first one.
    const userMsg = parsed.data.content.trim();
    addMessage(conv.id, "user", userMsg);
    if (prior.length === 0) {
      renameConversation(conv.id, req.user!.id, userMsg.slice(0, 60));
    }

    // CORS-aligned SSE headers (same as /chat).
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
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const provider = providerForModel(profile.model);
    const stream = provider === "openai" ? streamOpenAI : provider === "gemini" ? streamGemini : streamAnthropic;
    const defaults = getUserDefaults(req.user!.id);

    let full = "";
    try {
      await stream({
        profile,
        // Practice chat: no live captions; the user's message IS the question.
        transcriptWindow: "",
        userIntent: userMsg,
        priorTurns,
        defaults,
        onText: (text) => { full += text; send("chunk", { type: "text", text }); },
        onTool: (evt) => send("chunk", { type: "tool", ...evt }),
        onDone: (usage) => {
          logUsage({ userId: req.user!.id, provider, model: profile.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
          send("done", { type: "done", usage });
        },
      });
      if (full.trim()) addMessage(conv.id, "assistant", full);
      touchConversation(conv.id, req.user!.id);
    } catch (err) {
      app.log.error({ err }, "conversation stream failed");
      send("chunk", { type: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });
}
