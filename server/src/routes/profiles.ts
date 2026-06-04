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
import { extractIdentityFromResume } from "../claude/client.js";

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
});

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/profiles", async () => ({ profiles: listProfiles() }));

  app.get<{ Params: { id: string } }>("/profiles/:id", async (req, reply) => {
    const profile = getProfile(req.params.id);
    if (!profile) return reply.notFound("Profile not found");
    return profile;
  });

  app.post("/profiles", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    return reply.code(201).send(createProfile(parsed.data));
  });

  app.patch<{ Params: { id: string } }>("/profiles/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const updated = updateProfile(req.params.id, parsed.data);
    if (!updated) return reply.notFound("Profile not found");
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/profiles/:id", async (req, reply) => {
    if (!deleteProfile(req.params.id)) return reply.notFound("Profile not found");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/profiles/:id/activate", async (req, reply) => {
    const activated = activateProfile(req.params.id);
    if (!activated) return reply.notFound("Profile not found");
    return activated;
  });

  // Use Claude to extract jobTitle / company / location from the resume(s).
  app.post<{ Params: { id: string } }>("/profiles/:id/extract-identity", async (req, reply) => {
    const profile = getProfile(req.params.id);
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
    });
    return updated;
  });
}
