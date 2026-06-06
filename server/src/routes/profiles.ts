import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SUPPORTED_MODELS } from "@brandon/shared";
import {
  activateProfile,
  createProfile,
  deleteProfile,
  getProfile,
  listProfileFilesWithText,
  listProfiles,
  updateProfile,
} from "../db/profiles.js";
// Identity extraction now goes through OpenAI (gpt-5.5) instead of Claude haiku.
// Résumé identity extraction uses Claude Haiku: cheap, fast, deterministic, and
// (unlike GPT-5.x reasoning models) it won't spend the small token budget on
// hidden reasoning and return empty content.
import { extractIdentityFromResume } from "../claude/client.js";
import { requireActive } from "../auth/guards.js";

const ModelEnum = z.enum(SUPPORTED_MODELS);

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  realtimePrompt: z.string().optional(),
  notesTemplate: z.string().nullable().optional(),
  model: ModelEnum.optional(),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  realtimePrompt: z.string().optional(),
  notesTemplate: z.string().nullable().optional(),
  model: ModelEnum.optional(),
  fullName: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  voiceSample: z.string().nullable().optional(),
  interviewBrief: z.string().nullable().optional(),
  repoRoot: z.string().nullable().optional(),
});

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/profiles", async (req) => ({ profiles: listProfiles(req.user!.id) }));

  app.get<{ Params: { id: string } }>("/profiles/:id", async (req, reply) => {
    const profile = getProfile(req.params.id, req.user!.id);
    if (!profile) return reply.notFound("Profile not found");
    return profile;
  });

  app.post("/profiles", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    return reply.code(201).send(createProfile(parsed.data, req.user!.id));
  });

  app.patch<{ Params: { id: string } }>("/profiles/:id", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const updated = updateProfile(req.params.id, parsed.data, req.user!.id);
    if (!updated) return reply.notFound("Profile not found");
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/profiles/:id", async (req, reply) => {
    if (requireActive(req, reply)) return;
    if (!deleteProfile(req.params.id, req.user!.id)) return reply.notFound("Profile not found");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/profiles/:id/activate", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const activated = activateProfile(req.params.id, req.user!.id);
    if (!activated) return reply.notFound("Profile not found");
    return activated;
  });

  // Use OpenAI to extract jobTitle / company / location from the resume(s).
  app.post<{ Params: { id: string } }>("/profiles/:id/extract-identity", async (req, reply) => {
    if (requireActive(req, reply)) return;
    const profile = getProfile(req.params.id, req.user!.id);
    if (!profile) return reply.notFound("Profile not found");
    const files = listProfileFilesWithText(profile.id);
    if (files.length === 0) {
      return reply.badRequest("No reference files uploaded — upload a résumé first");
    }
    const combined = files
      .map((f) => `--- ${f.filename} ---\n${f.extractedText}`)
      .join("\n\n");
    const id = await extractIdentityFromResume(combined);
    const updated = updateProfile(profile.id, {
      fullName: id.fullName,
      jobTitle: id.jobTitle,
      company: id.company,
      location: id.location,
    }, req.user!.id);
    return updated;
  });
}
