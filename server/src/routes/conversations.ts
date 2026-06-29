import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatImage, ChatTurn, ProfileWithFiles } from "@brandon/shared";
import { providerForModel } from "@brandon/shared";
import {
  addMessage, createConversation, deleteConversation, getConversation,
  listConversations, listMessages, renameConversation, touchConversation,
  truncateFromMessage,
} from "../db/conversations.js";
import { getActiveProfile, getProfile } from "../db/profiles.js";
import { getUserDefaults } from "../db/users.js";
import { logUsage } from "../db/usage.js";
import { streamCompletion as streamAnthropic } from "../claude/client.js";
import { streamCompletion as streamOpenAI } from "../openai/client.js";
import { streamCompletion as streamGemini } from "../gemini/client.js";
import { requireActive } from "../auth/guards.js";
import { isAllowedOrigin } from "../cors.js";

// Sentinel stored in conversations.profile_id meaning "plain assistant" (no
// interview persona). A real profile id otherwise; we resolve the model below.
const PLAIN = "__plain__";
// Default raw model for the plain assistant (no persona).
const PLAIN_MODEL = "gpt-4o";

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/conversations", async (req) => ({ conversations: listConversations(req.user!.id) }));

  app.get<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    const conv = getConversation(req.params.id, req.user!.id);
    if (!conv) return reply.notFound("Conversation not found");
    return { conversation: conv, messages: listMessages(conv.id) };
  });

  // Create a chat. Optional profileId: a real mode id, "__plain__" for the plain
  // assistant, or omitted → the user's active mode.
  const CreateBody = z.object({ profileId: z.string().nullable().optional() });
  app.post("/conversations", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const parsed = CreateBody.safeParse(req.body ?? {});
    const requested = parsed.success ? parsed.data.profileId : undefined;
    let profileId: string | null;
    if (requested === PLAIN) profileId = PLAIN;
    else if (requested) profileId = requested; // a specific mode
    else profileId = getActiveProfile(req.user!.id)?.id ?? null;
    const conv = createConversation(req.user!.id, profileId);
    return reply.code(201).send(conv);
  });

  app.delete<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    if (requireActive(req, reply)) return;
    if (!deleteConversation(req.params.id, req.user!.id)) return reply.notFound("Conversation not found");
    return reply.code(204).send();
  });

  // Truncate: delete a message and everything after it (edit-and-regenerate).
  // The client then POSTs the edited text as a fresh message.
  app.delete<{ Params: { id: string; messageId: string } }>(
    "/conversations/:id/messages/:messageId",
    async (req, reply) => {
      if (requireActive(req, reply)) return;
      const removed = truncateFromMessage(req.params.id, req.user!.id, req.params.messageId);
      if (removed === null) return reply.notFound("Message not found");
      return { removed };
    },
  );

  // Rename a chat.
  const RenameBody = z.object({ title: z.string().trim().min(1).max(120) });
  app.patch<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const conv = getConversation(req.params.id, req.user!.id);
    if (!conv) return reply.notFound("Conversation not found");
    const parsed = RenameBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    renameConversation(conv.id, req.user!.id, parsed.data.title);
    return { ...conv, title: parsed.data.title };
  });

  // Post a user message and stream the assistant reply (SSE). Persists both.
  const PostBody = z.object({
    content: z.string().min(1),
    images: z.array(z.object({ mediaType: z.string(), data: z.string() })).optional(),
  });
  app.post<{ Params: { id: string } }>("/conversations/:id/messages", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const conv = getConversation(req.params.id, req.user!.id);
    if (!conv) return reply.notFound("Conversation not found");
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    // Resolve who answers. Plain mode → a synthetic empty profile + plain flag
    // (generic assistant, no persona/resume). Otherwise the conversation's mode,
    // else the active one.
    const isPlain = conv.profileId === PLAIN;
    let profile: ProfileWithFiles | null;
    if (isPlain) {
      profile = makePlainProfile(req.user!.id);
    } else {
      const profileId = conv.profileId ?? getActiveProfile(req.user!.id)?.id ?? null;
      profile = profileId ? getProfile(profileId, req.user!.id) : null;
      if (!profile) return reply.badRequest("No mode selected — pick a mode or 'Plain assistant'.");
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
        images: parsed.data.images,
        defaults,
        plain: isPlain,
        onText: (text) => { full += text; send("chunk", { type: "text", text }); },
        onTool: (evt) => send("chunk", { type: "tool", ...evt }),
        onDone: (usage) => {
          logUsage({ userId: req.user!.id, provider, model: profile!.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
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

// A throwaway profile object for plain mode. With plain:true, buildPrompt skips
// all persona/resume logic, so only `id` (no files) and `model` matter.
function makePlainProfile(userId: string): ProfileWithFiles {
  const now = Date.now();
  return {
    id: `plain-${userId}`, name: "Plain assistant", realtimePrompt: "",
    notesTemplate: null, model: PLAIN_MODEL, isActive: false,
    fullName: null, jobTitle: null, company: null, location: null,
    voiceSample: null, interviewBrief: null, repoRoot: null,
    createdAt: now, updatedAt: now, files: [],
  };
}
