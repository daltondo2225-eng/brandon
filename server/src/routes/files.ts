import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import { SUPPORTED_MIME_TYPES } from "@brandon/shared";
import { config } from "../config.js";
import {
  deleteReferenceFile,
  getProfile,
  getReferenceFile,
  insertReferenceFile,
} from "../db/profiles.js";
import { extractByMime } from "../ingest/index.js";

const SUPPORTED_MIME_SET = new Set<string>(SUPPORTED_MIME_TYPES);

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>("/profiles/:id/files", async (req, reply) => {
    const profile = getProfile(req.params.id);
    if (!profile) return reply.notFound("Profile not found");

    const part = await req.file();
    if (!part) return reply.badRequest("Missing file upload");

    const mime = part.mimetype;
    if (!SUPPORTED_MIME_SET.has(mime)) {
      return reply.badRequest(`Unsupported file type: ${mime}`);
    }

    const buffer = await part.toBuffer();
    let extractedText: string;
    try {
      extractedText = await extractByMime(mime, buffer);
    } catch (err) {
      app.log.error({ err }, "extraction failed");
      return reply.badRequest(`Failed to extract text: ${(err as Error).message}`);
    }
    if (!extractedText) return reply.badRequest("File produced no extractable text");

    const profileDir = resolve(config.uploadsDir, profile.id);
    mkdirSync(profileDir, { recursive: true });
    const fileId = nanoid(12);
    const safeName = part.filename.replace(/[^\w.\-]+/g, "_");
    const storagePath = resolve(profileDir, `${fileId}_${safeName}`);
    writeFileSync(storagePath, buffer);

    const record = insertReferenceFile({
      profileId: profile.id,
      filename: part.filename,
      mime,
      size: buffer.length,
      storagePath,
      extractedText,
    });
    return reply.code(201).send(record);
  });

  app.delete<{ Params: { fileId: string } }>("/files/:fileId", async (req, reply) => {
    const existing = getReferenceFile(req.params.fileId);
    if (!existing) return reply.notFound("File not found");
    if (existsSync(existing.storagePath)) {
      try { unlinkSync(existing.storagePath); } catch (err) { app.log.warn({ err }, "failed to delete file from disk"); }
    }
    deleteReferenceFile(req.params.fileId);
    return reply.code(204).send();
  });
}
