import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  setSessionCompany,
  updateSession,
} from "../db/sessions.js";
import { upsertCompanyByName } from "../db/companies.js";
import { getProfile } from "../db/profiles.js";
// Recaps now go through OpenAI (gpt-5.5). Switched from Claude haiku to put
// the user's OpenAI quota to work for the heavier transcript summarisation.
import { generateRecap } from "../openai/client.js";

const CreateBody = z.object({
  profileId: z.string().nullable().optional(),
  title: z.string().optional(),
  targetCompany: z.string().nullable().optional(),
  jobDescription: z.string().nullable().optional(),
});

const UpdateBody = z.object({
  title: z.string().optional(),
  endedAt: z.number().nullable().optional(),
  transcript: z.string().nullable().optional(),
  recap: z.string().nullable().optional(),
  priorTurnsJson: z.string().nullable().optional(),
});

const ListQuery = z.object({
  profileId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/sessions", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    return { sessions: listSessions(parsed.data.profileId, parsed.data.limit) };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const s = getSession(req.params.id);
    if (!s) return reply.notFound("Session not found");
    return s;
  });

  app.post("/sessions", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    if (parsed.data.profileId) {
      const profile = getProfile(parsed.data.profileId);
      if (!profile) return reply.notFound("Profile not found");
    }
    const title = parsed.data.title?.trim() || defaultTitle();
    // If the user supplied a target company in the pre-interview modal, link
    // the session to a Company row (creating one if it's a new opportunity).
    let companyId: string | null = null;
    const targetCompany = parsed.data.targetCompany?.trim() ?? null;
    if (targetCompany) companyId = upsertCompanyByName(targetCompany).id;
    const s = createSession(
      parsed.data.profileId ?? null,
      title,
      targetCompany,
      parsed.data.jobDescription ?? null,
      companyId,
    );
    return reply.code(201).send(s);
  });

  app.patch<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const s = updateSession(req.params.id, parsed.data);
    if (!s) return reply.notFound("Session not found");
    return s;
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    if (!deleteSession(req.params.id)) return reply.notFound("Session not found");
    return reply.code(204).send();
  });

  // Generate (or regenerate) a Claude recap + auto-title for a session.
  app.post<{ Params: { id: string } }>("/sessions/:id/recap", async (req, reply) => {
    const s = getSession(req.params.id);
    if (!s) return reply.notFound("Session not found");
    if (!s.transcript || s.transcript.trim().length < 10) {
      return reply.badRequest("Session has no transcript to summarise");
    }
    const { title, recap, nextSteps } = await generateRecap({
      transcript: s.transcript,
      targetCompany: s.targetCompany,
      jobDescription: s.jobDescription,
    });
    // Only overwrite the title if the model produced one AND the current title
    // is still the auto-generated `Meeting · ...` placeholder. A user-renamed
    // session should stick.
    const patch: { title?: string; recap: string; nextStepsJson: string } = {
      recap,
      nextStepsJson: JSON.stringify(nextSteps),
    };
    if (title && (s.title.startsWith("Meeting") || s.title.trim().length === 0)) {
      patch.title = title;
    }
    const updated = updateSession(req.params.id, patch);
    return updated;
  });
}

function defaultTitle(): string {
  const d = new Date();
  const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `Meeting · ${dateStr} ${timeStr}`;
}
