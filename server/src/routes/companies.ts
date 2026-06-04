import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COMPANY_STATUSES } from "@brandon/shared";
import {
  deleteCompany,
  findCompanyByName,
  listPipeline,
  updateCompany,
  upsertCompanyByName,
} from "../db/companies.js";
import { db } from "../db/client.js";
import { setSessionCompany } from "../db/sessions.js";

const PatchBody = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.enum(COMPANY_STATUSES as readonly [string, ...string[]]).optional(),
  notes: z.string().nullable().optional(),
});

const ListQuery = z.object({
  profileId: z.string().optional(),
});

export async function registerCompanyRoutes(app: FastifyInstance): Promise<void> {
  // The pipeline view: companies + aggregated session/recap data. Accepts an
  // optional ?profileId= to scope sessions (and thus companies) to one profile.
  app.get("/companies", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    return { companies: listPipeline(parsed.data.profileId) };
  });

  app.patch<{ Params: { id: string } }>("/companies/:id", async (req, reply) => {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const updated = updateCompany(req.params.id, parsed.data as never);
    if (!updated) return reply.notFound("Company not found");
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/companies/:id", async (req, reply) => {
    if (!deleteCompany(req.params.id)) return reply.notFound("Company not found");
    return reply.code(204).send();
  });

  /**
   * Backfill: link existing sessions to companies. For each session without a
   * company_id, derive a company name from `target_company` first, then from
   * the parsed stage-suffix of the title ("Intro call with Mercury" → "Mercury").
   * Idempotent — safe to call repeatedly.
   */
  app.post("/companies/backfill", async () => {
    interface SRow {
      id: string;
      title: string;
      target_company: string | null;
    }
    const rows = db.prepare(
      `SELECT id, title, target_company FROM sessions WHERE company_id IS NULL`,
    ).all() as unknown as SRow[];
    let linked = 0;
    let created = 0;
    let skipped = 0;
    for (const r of rows) {
      const candidates = [r.target_company?.trim(), extractCompanyFromTitle(r.title)]
        .filter((n): n is string => !!n && !isJunkCompanyName(n));
      const name = candidates[0];
      if (!name) { skipped++; continue; }
      const existing = findCompanyByName(name);
      const company = existing ?? upsertCompanyByName(name);
      if (!existing) created++;
      setSessionCompany(r.id, company.id);
      linked++;
    }
    return { linked, created, skipped, total: rows.length };
  });

  /**
   * Remove companies whose name is clearly junk that an earlier (looser)
   * backfill created — date placeholders, 2-letter strings, role labels.
   * Idempotent.
   */
  app.post("/companies/prune", async () => {
    interface CRow { id: string; name: string; }
    const rows = db.prepare("SELECT id, name FROM companies").all() as unknown as CRow[];
    let removed = 0;
    for (const r of rows) {
      if (isJunkCompanyName(r.name)) {
        if (deleteCompany(r.id)) removed++;
      }
    }
    return { removed, scanned: rows.length };
  });
}

/**
 * "Intro call with Mercury" → "Mercury".
 * "Tech interview · Datadog" → "Datadog".
 * "Recruiter screen — Stripe" → "Stripe".
 * Returns null when the title is the auto "Meeting · …" placeholder, the
 * candidate suffix looks like a date/time, or it's obviously a role label.
 */
function extractCompanyFromTitle(title: string): string | null {
  if (!title) return null;
  const t = title.trim();
  if (/^(meeting|untitled)\b/i.test(t)) return null;
  const m = t.match(/\s+(?:with|—|·|-)\s+(.+)$/i);
  if (!m) return null;
  const candidate = m[1].trim();
  if (candidate.length < 3) return null;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d/i.test(candidate)) return null;
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(candidate)) return null;
  if (/^(brandon)$/i.test(candidate)) return null;
  if (/\b(candidate|interviewer|engineer|developer|manager|designer|recruiter)$/i.test(candidate)) return null;
  return candidate;
}

function isJunkCompanyName(name: string): boolean {
  const t = name.trim();
  if (t.length < 3) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d/i.test(t)) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(t)) return true;
  if (/^(brandon|candidate|untitled)$/i.test(t)) return true;
  if (/\b(candidate|interviewer)$/i.test(t)) return true;
  return false;
}
